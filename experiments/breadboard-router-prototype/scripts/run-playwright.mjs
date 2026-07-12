import { chromium } from "playwright";
import { rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { route, DEFAULT_BOARD, SAMPLE_PARTS } from "../router.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "index.html");
const screenshotDir = path.join(root, "screenshots");
const reportPath = path.join(screenshotDir, "run-report.json");

const viewport = { width: 2048, height: 1152 };
const attempts = Number(process.env.ROUTER_ATTEMPTS || 8);
const seedBase = Number(process.env.ROUTER_SEED || 1739);

await rm(screenshotDir, { recursive: true, force: true });
await mkdir(screenshotDir, { recursive: true });

const browser = await chromium.launch({ headless: true });

try {
  const results = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const seed = seedBase + attempt;
    const result = await runAttempt(browser, attempt, seed);
    results.push(result);
  }

  const best = results.toSorted(compareResults)[0];

  // Run the headless Node.js module on the same seed for cross-validation
  const headlessSolution = route(
    { board: DEFAULT_BOARD, parts: SAMPLE_PARTS },
    { seed: seedBase + best.attempt, iterations: 900 }
  );
  const solutionPath = path.join(screenshotDir, "solution.json");
  await writeFile(solutionPath, JSON.stringify(headlessSolution, null, 2), "utf8");

  // Capture browser solution via window.exportSolution for comparison
  const browserSolution = best.optimize.solution || null;

  const report = {
    generatedAt: new Date().toISOString(),
    page: pathToFileURL(htmlPath).href,
    attempts,
    seedBase,
    screenshots: {
      initial: best.screenshots.initial,
      plan: best.screenshots.plan,
      optimize: best.screenshots.optimize
    },
    plan: best.plan,
    optimize: best.optimize,
    verdict: best.verdict,
    bestAttempt: best.attempt,
    headlessModule: {
      ok: headlessSolution.ok,
      metrics: headlessSolution.metrics
    },
    allAttempts: results.map(result => ({
      attempt: result.attempt,
      seed: result.seed,
      verdict: result.verdict,
      plan: result.plan.metrics,
      optimize: result.optimize.metrics,
      screenshot: result.screenshots.optimize
    }))
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({
    report: reportPath,
    verdict: report.verdict,
    bestAttempt: report.bestAttempt,
    attempts,
    plan: best.plan.metrics,
    optimize: best.optimize.metrics,
    headlessModule: report.headlessModule,
    solution: solutionPath
  }, null, 2));
} finally {
  await browser.close();
}

async function runAttempt(browser, attempt, seed) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await page.addInitScript(seedRandom, seed);
  const prefix = String(attempt).padStart(2, "0");
  try {
    await page.goto(pathToFileURL(htmlPath).href);
    const initialPath = path.join(screenshotDir, `${prefix}-initial.png`);
    const planPath = path.join(screenshotDir, `${prefix}-plan.png`);
    const optimizePath = path.join(screenshotDir, `${prefix}-optimize.png`);
    await page.screenshot({ path: initialPath, fullPage: true });

    await page.getByRole("button", { name: "Plan" }).click();
    await page.waitForFunction(() => document.querySelector("#metrics")?.textContent?.includes("objective"));
    await page.screenshot({ path: planPath, fullPage: true });
    const plan = await collectState(page);

    await page.getByRole("button", { name: "Optimize" }).click();
    await page.waitForFunction(() => document.querySelector("#log")?.textContent?.includes("optimize:"), null, { timeout: 90000 });
    await page.screenshot({ path: optimizePath, fullPage: true });
    const optimize = await collectState(page);

    return {
      attempt,
      seed,
      screenshots: { initial: initialPath, plan: planPath, optimize: optimizePath },
      plan,
      optimize,
      verdict: verdictFor(optimize)
    };  } finally {
    await page.close();
  }
}

function seedRandom(seed) {
  let state = seed >>> 0;
  Math.random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function compareResults(a, b) {
  const av = a.verdict === "pass" ? 0 : 1;
  const bv = b.verdict === "pass" ? 0 : 1;
  if (av !== bv) return av - bv;
  const af = Number(a.optimize.metrics["failed nets"] || 0);
  const bf = Number(b.optimize.metrics["failed nets"] || 0);
  if (af !== bf) return af - bf;
  const ar = Number(a.optimize.metrics["unresolved nets"] || 0);
  const br = Number(b.optimize.metrics["unresolved nets"] || 0);
  if (ar !== br) return ar - br;
  return Number(a.optimize.metrics.objective || Infinity) - Number(b.optimize.metrics.objective || Infinity);
}

async function collectState(page) {
  return page.evaluate(collectPrototypeState);
}

function collectPrototypeState() {
  const parseMetric = value => {
    const text = value?.trim() || "";
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    return text;
  };

  const metrics = {};
  for (const dt of [...document.querySelectorAll("#metrics dt")]) {
    const dd = dt.nextElementSibling;
    metrics[dt.textContent.trim()] = parseMetric(dd?.textContent);
  }

  const validation = textLines("#validation");
  const log = textLines("#log");
  const boardParts = [...document.querySelectorAll(".part-board text, text.part-label")]
    .map(node => node.textContent.trim())
    .filter(Boolean);

  return {
    metrics,
    validation,
    logTail: log.slice(-20),
    wireCount: document.querySelectorAll(".wire-path").length,
    ratCount: document.querySelectorAll(".ratline").length,
    crossingDetails: collectCrossings(),
    boardParts,
    solution: typeof window.exportSolution === "function" ? window.exportSolution() : null
  };

  function textLines(selector) {
    return (document.querySelector(selector)?.textContent || "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  }

  function collectCrossings() {
    const wires = [...document.querySelectorAll(".wire-path")].map((path, index) => ({
      index,
      net: path.getAttribute("data-net") || "",
      kind: path.getAttribute("data-kind") || "",
      segments: segmentsForPath(path.getAttribute("d") || "")
    }));

    const crossings = [];
    for (let i = 0; i < wires.length; i += 1) {
      for (let j = i + 1; j < wires.length; j += 1) {
        if (wires[i].net === wires[j].net) continue;
        for (const a of wires[i].segments) {
          for (const b of wires[j].segments) {
            if (shareEndpoint(a, b)) continue;
            if (crosses(a, b)) {
              crossings.push({
                a: `${wires[i].net}:${wires[i].kind}`,
                b: `${wires[j].net}:${wires[j].kind}`,
                point: crossingPoint(a, b)
              });
            }
          }
        }
      }
    }
    return crossings.slice(0, 80);
  }

  function segmentsForPath(d) {
    const nums = [...d.matchAll(/[-+]?\d*\.?\d+/g)].map(match => Number(match[0]));
    const points = [];
    for (let i = 0; i < nums.length; i += 2) points.push({ x: nums[i], y: nums[i + 1] });
    const segments = [];
    for (let i = 1; i < points.length; i += 1) segments.push([points[i - 1], points[i]]);
    return segments;
  }

  function shareEndpoint(a, b) {
    return same(a[0], b[0]) || same(a[0], b[1]) || same(a[1], b[0]) || same(a[1], b[1]);
  }

  function same(a, b) {
    return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
  }

  function crosses(a, b) {
    const av = a[0].x === a[1].x;
    const bv = b[0].x === b[1].x;
    if (av === bv) return false;
    const vertical = av ? a : b;
    const horizontal = av ? b : a;
    return between(vertical[0].x, horizontal[0].x, horizontal[1].x) &&
      between(horizontal[0].y, vertical[0].y, vertical[1].y);
  }

  function crossingPoint(a, b) {
    const av = a[0].x === a[1].x;
    const vertical = av ? a : b;
    const horizontal = av ? b : a;
    return { x: vertical[0].x, y: horizontal[0].y };
  }

  function between(value, a, b) {
    return value >= Math.min(a, b) && value <= Math.max(a, b);
  }
}

function verdictFor(state) {
  const failed = Number(state.metrics["failed nets"] || 0);
  const unresolved = Number(state.metrics["unresolved nets"] || 0);
  if (failed === 0 && unresolved === 0) return "pass";
  return "fail";
}
