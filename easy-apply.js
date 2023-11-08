import { chromium } from 'playwright';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import config from './config.js';

// ============ Config =================
const {
  email,
  password,
  keywordsList,
  date,
  location,
  keywordsBlackList,
} = config;
// =====================================

// ============== Main ==================
// Stats
let jobsAppliedCount = 0;
let jobsFailedCount = 0;
let jobsProcessedCount = 0;

// File log
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logFilename = new Date()
  .toISOString()
  .slice(0, 19)
  .replaceAll(':', '-')
  .concat('.log');

const logFilepath = path.resolve(__dirname, './logs/', logFilename);
const fd = fs.openSync(logFilepath, 'a');

console.log('Launching Chrome browser...');

// Start up browser
const launchOptions = { headless: false, args: ["--start-maximized"] };
const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36',
  viewport: null,
});
const page = await context.newPage();

console.log('Logging in to LinkedIn...');

// Log in
const util = await import('util');

// Wrap setTimeout with a Promise
const sleep = util.promisify(setTimeout);

await page.goto('https://www.linkedin.com/');
await page.type('#session_key', email);
await page.type('#session_password', password);
await page.click('button[type=submit]');

// Sleep Thread (3000 milliseconds)
await sleep(3000);

console.log('Successfully logged in!');

// Run Search-Apply process sequentially for all keywords
try {
  await forEachAsync(keywordsList, async keywords => {
    log(`Searching jobs that match "${keywords}"`)
    await searchJobs(keywords)
    await applyUntilNoMoreJobs(keywords)
  })
} catch (e) {
  log('Unexpected error: ' + e)
}

await context.close()
await browser.close()

log('Finished applying for jobs.')
log('===================================')
log('Processed jobs count: ' + jobsProcessedCount)
log('Applied for jobs count: ' + jobsAppliedCount)
log('Failed to apply count: ' + jobsFailedCount)

// ================================================

// ================ Functions =====================

async function searchJobs(keywords) {
  const url = 'https://www.linkedin.com/jobs/search/?refresh=true&' +
    `keywords=${keywords}&` +
    `f_TPR=${date}&` +
    `location=${location}&` +
    `f_WT=2&` + // Remote
    `f_AL=true` // Easy Apply

  await page.goto(url)
}

async function applyUntilNoMoreJobs(keywords) {
  // Mimic a user reading a job before moving to next job or applying
  await randomWait(2000, 5000)

  // info for stats
  jobsProcessedCount++

  const shouldApply = await isJobValidForApplying(keywords)
  if (shouldApply) {
    await applyForJob()
    await logJobAppliedStatus()
    // after applying, wait a bit before moving to next job
    await randomWait(2000, 3000)
  }

  if (await nextJob())
    await applyUntilNoMoreJobs(keywords)
}

async function isJobValidForApplying(keywords) {
  const job = await currentJob()

  if (job.applied) return false

  // const hasKeywords = await hasJobKeywords(keywords)
  // if (!hasKeywords) return false
  //
  // const hasBlackListedKeywords = await hasJobBlackListedKeywords()
  // if (hasBlackListedKeywords) return false

  // LinkedIn sometimes includes non-easy-apply jobs in search results list, 
  // so we have to exclude such
  const isExternalLink = await page
    .locator('.jobs-search__job-details .jobs-s-apply button[role]')
    .first()
    .isVisible()
  if (isExternalLink) return false

  return true
}

async function hasJobKeywords(keywords) {
  const re = RegExp(keywords, 'gi')
  const jobDetails = await page
    .locator('.jobs-search__job-details--container')
    .innerText()
  return !!jobDetails.match(re)
}

async function hasJobBlackListedKeywords() {
  const re = RegExp(keywordsBlackList.join('|'), 'gi')
  const jobDetails = await page
    .locator('.jobs-search__job-details--container')
    .innerText()
  return !!jobDetails.match(re)
}

async function applyForJob() {
  // Click Easy Apply button within job details right pane
  await page.locator('.jobs-apply-button').first().click()

  // Wait for Easy Apply modal to appear
  const easyApplyModal = page.locator('[data-test-modal-id="easy-apply-modal"]')
  await easyApplyModal.waitFor()

  // Recursively click next until applied or stuck
  await clickNextUntilAppliedOrStuck()

  // wait a bit before closing modals
  await randomWait(2000, 5000)

  // Did we apply successfully? If we applied, then easy apply modal is already closed
  const applied = await easyApplyModal.waitFor()
    .then(() => false)
    .catch(() => true)

  if (applied) {
    // Wait for follow-up Done/Add Skills modal to close,
    // that appears in a few seconds after Easy Modal closed
    await page.click('[data-test-modal-close-btn]', { timeout: 5000 }).catch(() => { })

    // Update stats
    jobsAppliedCount++
  }
  else {
    // Close Easy Apply Modal
    await easyApplyModal.locator('[data-test-modal-close-btn]').click()
    await randomWait(2000, 3000)
    await page
      .locator('[data-test-modal-id="data-test-easy-apply-discard-confirmation"]')
      .locator('[data-control-name="discard_application_confirm_btn"]')
      .click()

    // Update stats
    jobsFailedCount++
  }

  return applied
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function clickNextUntilAppliedOrStuck() {
  // Mimic a user slow interaction
  await randomWait(2000, 5000);

  const easyApplyModal = page.locator('[data-test-modal-id="easy-apply-modal"]');

  // Track progress to determine whether we got stuck (job requires manual applying)
  const progress = async () =>
    await easyApplyModal.locator('progress').isVisible()
      ? await easyApplyModal.locator('progress').getAttribute('value')
      : 100;

  const progressBefore = +(await progress());

  // Uncheck Follow the Company checkbox at the last step
  if (progressBefore == 100) {
    await easyApplyModal
      .locator('[for="follow-company-checkbox"]')
      .click()
      .catch(() => log(`Couldn't uncheck Follow Company checkbox.`));
  }

  // Delay for 5 seconds
  await delay(5000);

  // Click next step
  await easyApplyModal.locator('.artdeco-button--primary').click();

  const progressAfter = +(await progress());

  // Proceed to the next step until we applied for the job or got stuck
  if (progressAfter > progressBefore) {
    await delay(5000); // Delay for 5 seconds before proceeding
    await clickNextUntilAppliedOrStuck();
  }
}


async function nextJob() {
  const currentJobId = (await currentJob()).id

  const lastJobId = await page
    .locator('[data-occludable-job-id]')
    .last()
    .getAttribute('data-occludable-job-id')

  // Get paging information if there are more jobs than one page can accomodate
  const lastPage = await page
    .locator('[data-test-pagination-page-btn]')
    .last()
    .getAttribute('data-test-pagination-page-btn', { timeout: 1000 })
    .catch(() => { }) // In case if there is no pagination at all

  const currentPage = await page
    .locator('[data-test-pagination-page-btn].active')
    .getAttribute('data-test-pagination-page-btn', { timeout: 1000 })
    .catch(() => { })

  // Quit if no more jobs
  if (currentPage == lastPage && currentJobId == lastJobId) {
    return false
  }
  // Go to next page if current job is the last one
  else if (currentJobId == lastJobId) {
    await page
      .click('li[data-test-pagination-page-btn].active + li')
      .catch(() => { })
  }
  // Go to next job
  else {
    // Select/click next job
    await page.click(`li[data-occludable-job-id="${currentJobId}"] + li`)

    // Scroll down a bit to make sure new jobs load
    const scrollHeight = await page
      .locator(`li[data-occludable-job-id="${currentJobId}"] + li`)
      .evaluate(node => node.scrollHeight)

    await page
      .locator('.jobs-search-results-list')
      .evaluate((node, scrollHeight) => node.scrollBy(0, scrollHeight), scrollHeight)
  }

  // Wait until job details(right pane) get in sync with job list(left pane)
  const nextJobId = (await currentJob()).id
  await page
    .locator(
      `.job-details-jobs-unified-top-card__content--two-pane a[href*="${nextJobId}"]`
    )
    .waitFor()

  return true
}

async function currentJob() {
  const container = page.locator('.jobs-search-results-list__list-item--active')

  const id = await container.getAttribute('data-job-id')
  const company = await container
    .locator('.job-card-container__primary-description')
    .innerText()

  const link = container.locator('.job-card-container__link')
  const title = await link.innerText()
  const url = 'https://www.linkedin.com' +
    (await link.getAttribute('href')).split('?')[0] // remove very long query string

  const applied = await page
    .locator('.jobs-search__job-details .jobs-s-apply [type="success-pebble-icon"]')
    .first()
    .isVisible()

  return { id, title, company, url, applied }
}

async function randomWait(min, max) {
  const delay = Math.max(min, max * Math.random())
  return page.waitForTimeout(delay)
}

function log(msg) {
  fs.appendFileSync(fd, msg + '\n', 'utf8')
  console.log(msg)
}

async function logJobAppliedStatus() {
  const { title, company, url, applied } = await currentJob()
  const msg = applied ?
    `Successfully applied for '${title}' at '${company}' ${url}` :
    `Failed to apply for '${title}' at '${company}' ${url}`
  log(msg)
}

async function forEachAsync(array, asyncFn) {
  return array.reduce(
    (promise, val) => promise.then(asyncFn.bind(null, val)),
    Promise.resolve()
  )
}
