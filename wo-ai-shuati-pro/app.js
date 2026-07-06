import { cloud, CLOUD_API_VERSION } from "./cloud.js";
import {
  areLocalQuestionsSameAsCloud,
  buildReviewExport,
  buildReviewGroups,
  calculateBankProgress,
  dedupeQuestionsForPractice,
  findSavedPublicBank,
  getPublishBlocker,
  isProfileComplete,
  mapCloudBankToLocal,
  mapCloudProgressToLocal,
  mapPublicBankToLocal,
  mergeProgressRows,
} from "./public-bank-domain.js";

const DB_NAME = "wo-ai-shuati-pro-db";
const DB_VERSION = 2;
const STORE_BANKS = "banks";
const STORE_QUESTIONS = "questions";
const STORE_PROGRESS = "progress";
const STORE_EXAM_SESSIONS = "examSessions";
const CURRENT_BANK_KEY = "wo-ai-shuati-pro-current-bank";
const PRACTICE_SESSION_KEY = "wo-ai-shuati-pro-practice-session";
const SESSION_MODE_KEY = "wo-ai-shuati-pro-session-mode";
const ANSWER_FEEDBACK_KEY = "wo-ai-shuati-pro-answer-feedback";
const THEME_KEY = "wo-ai-shuati-pro-theme";
const APP_VERSION_KEY = "wo-ai-shuati-pro-app-version";
const APP_CACHE_PREFIX = "wo-ai-shuati-pro-";
const SESSION_MODES = new Set(["practice", "exam"]);
const ANSWER_FEEDBACK_MODES = new Set(["instant", "submit"]);
const THEMES = new Set(["default", "tokyonight", "high-contrast", "topaz", "nord", "solarized"]);

const state = {
  view: "banks",
  banks: [],
  allQuestions: [],
  allProgress: [],
  examSessions: [],
  currentBankId: localStorage.getItem(CURRENT_BANK_KEY) || "",
  questions: [],
  progress: new Map(),
  practiceMode: "sequential",
  sessionMode: normalizeSessionMode(localStorage.getItem(SESSION_MODE_KEY) || localStorage.getItem(ANSWER_FEEDBACK_KEY)),
  answerFeedbackMode: normalizeAnswerFeedbackMode(localStorage.getItem(ANSWER_FEEDBACK_KEY)),
  appTheme: normalizeTheme(localStorage.getItem(THEME_KEY)),
  queue: [],
  queueIndex: 0,
  selected: new Set(),
  submitted: false,
  lastResult: null,
  examRunResults: new Map(),
  lastExamRecord: null,
  examReviewIndex: 0,
  bankFilter: "",
  cloudConfigured: cloud.configured,
  cloudUser: null,
  cloudProfile: null,
  cloudReady: false,
  publicBanks: [],
  discoverQuery: "",
  discoverProfile: null,
  discoverLoading: false,
  syncStatus: "",
  editingBankId: "",
  importSheetOpen: false,
  bankBulkMode: false,
  publicBankBulkMode: false,
  selectedBankIds: new Set(),
  selectedPublicBankIds: new Set(),
  questionPickerOpen: false,
  reviewGroups: [],
  reviewLoading: false,
  reviewLoaded: false,
  expandedReviewBankIds: new Set(),
  appVersion: {
    current: localStorage.getItem(APP_VERSION_KEY) || "",
    latest: "",
    checking: true,
    updateAvailable: false,
    error: "",
  },
};

const view = document.querySelector("#view");
const toast = document.querySelector("#toast");
let dbPromise = null;
let toastTimer = null;

boot();

async function boot() {
  applyTheme(state.appTheme);
  bindGlobalEvents();
  await initCloud();
  await refreshBanks();
  await refreshExamSessions();
  if (state.currentBankId && state.banks.some((bank) => bank.id === state.currentBankId)) {
    await loadCurrentBank();
  } else if (state.banks[0]) {
    setCurrentBank(state.banks[0].id, false);
    await loadCurrentBank();
  }
  const sharedQuery = readSharedQuery();
  if (sharedQuery) {
    state.view = "discover";
    state.discoverQuery = sharedQuery;
    if (state.cloudConfigured) await searchPublicBanks();
  }
  render();
  registerServiceWorker();
  checkAppVersion();
}

function readSharedQuery() {
  const params = new URLSearchParams(location.search);
  return params.get("u") || params.get("user") || params.get("bank") || params.get("q") || "";
}

async function initCloud() {
  if (!state.cloudConfigured) return;
  cloud.handleAuthRedirect();
  if (!cloud.session?.access_token) {
    state.cloudReady = true;
    return;
  }
  try {
    const user = await cloud.getUser();
    state.cloudUser = user;
    state.cloudProfile = await cloud.getMyProfile(user.id);
  } catch (error) {
    console.warn("云端会话失效", error);
    cloud.clearSession();
    state.cloudUser = null;
    state.cloudProfile = null;
  } finally {
    state.cloudReady = true;
  }
}

function bindGlobalEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", async () => {
      state.editingBankId = "";
      state.questionPickerOpen = false;
      state.view = button.dataset.view;
      if (state.view === "practice" && state.currentBankId && state.questions.length === 0) {
        await loadCurrentBank();
      }
      if (state.view === "wrong") {
        await loadReviewGroups();
      }
      render();
    });
  });

  view.addEventListener("click", handleViewClick);
  view.addEventListener("submit", handleViewSubmit);
  view.addEventListener("change", handleViewChange);
  view.addEventListener("input", handleViewInput);
}

async function handleViewClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;

  if (action === "select-bank") {
    await selectBank(id, "practice");
  }
  if (action === "open-bank") {
    await selectBank(id, "banks");
  }
  if (action === "view-stats") {
    await selectBank(id || state.currentBankId, "stats");
  }
  if (action === "delete-bank") {
    await deleteBank(id);
  }
  if (action === "start-bank-bulk") {
    state.bankBulkMode = true;
    render();
  }
  if (action === "toggle-bank-selection") {
    toggleSelection(state.selectedBankIds, id);
    renderBankList();
    renderBankBulkBar();
  }
  if (action === "select-all-banks") {
    getFilteredBanks().forEach((bank) => state.selectedBankIds.add(bank.id));
    renderBankList();
    renderBankBulkBar();
  }
  if (action === "clear-bank-selection") {
    state.selectedBankIds.clear();
    state.bankBulkMode = false;
    render();
  }
  if (action === "delete-selected-banks") {
    await deleteSelectedBanks();
  }
  if (action === "publish-bank") {
    await publishLocalBank(id);
  }
  if (action === "update-published-bank") {
    await updatePublishedBank(id);
  }
  if (action === "copy-bank-id") {
    await copyText(id);
  }
  if (action === "edit-bank") {
    openBankEditor(id);
  }
  if (action === "close-edit-bank") {
    closeBankEditor();
  }
  if (action === "open-import") {
    state.importSheetOpen = true;
    render();
  }
  if (action === "close-import") {
    state.importSheetOpen = false;
    render();
  }
  if (action === "toggle-question-picker") {
    toggleQuestionPicker();
  }
  if (action === "close-question-picker") {
    closeQuestionPicker();
  }
  if (action === "jump-question") {
    jumpToQuestion(Number(target.dataset.index));
  }
  if (action === "set-mode") {
    if (hasActivePractice() && !confirm("切换练习模式会清空当前进行中的答题，确定继续吗？")) return;
    state.practiceMode = target.dataset.mode;
    state.questionPickerOpen = false;
    resetPracticeQueue();
    render();
  }
  if (action === "set-session-mode") {
    setSessionMode(target.dataset.mode);
  }
  if (action === "set-answer-feedback") {
    setAnswerFeedbackMode(target.dataset.mode);
  }
  if (action === "start-practice") {
    if (hasActivePractice() && !confirm("重新开始会清空当前进行中的答题，确定继续吗？")) return;
    startPractice();
  }
  if (action === "resume-practice") {
    resumePractice();
  }
  if (action === "choose-option") {
    await chooseOption(target.dataset.value);
  }
  if (action === "submit-answer") {
    await submitAnswer();
  }
  if (action === "finish-exam") {
    await finishExam();
  }
  if (action === "add-exam-wrongs") {
    await addExamWrongQuestions(target.dataset.id);
  }
  if (action === "review-exam-question") {
    reviewExamQuestion(Number(target.dataset.index));
  }
  if (action === "next-question") {
    nextQuestion();
  }
  if (action === "toggle-favorite") {
    await toggleFavorite(target.dataset.questionId);
  }
  if (action === "add-wrong") {
    await addToWrongBook(target.dataset.questionId);
  }
  if (action === "practice-wrong") {
    if (id) await selectBank(id, "practice");
    else state.view = "practice";
    state.practiceMode = "wrong";
    state.questionPickerOpen = false;
    startPractice();
  }
  if (action === "practice-favorite") {
    if (id) await selectBank(id, "practice");
    else state.view = "practice";
    state.practiceMode = "favorite";
    state.questionPickerOpen = false;
    startPractice();
  }
  if (action === "export-review-bank") {
    exportReviewBank(id);
  }
  if (action === "toggle-review-bank") {
    toggleReviewBank(id);
  }
  if (action === "master-question") {
    await markMastered(target.dataset.questionId);
  }
  if (action === "export-backup") {
    await exportBackup();
  }
  if (action === "clear-all") {
    await clearAllData();
  }
  if (action === "send-login-link") {
    await sendLoginLink();
  }
  if (action === "sign-in-provider") {
    await signInProvider(target.dataset.provider);
  }
  if (action === "sign-out") {
    await signOutCloud();
  }
  if (action === "save-profile") {
    await saveProfile();
  }
  if (action === "refresh-app") {
    await refreshAppAssets();
  }
  if (action === "search-public") {
    await searchPublicBanks();
  }
  if (action === "use-public-bank") {
    await usePublicBank(id);
  }
  if (action === "start-public-bank-bulk") {
    state.publicBankBulkMode = true;
    render();
  }
  if (action === "toggle-public-bank-selection") {
    toggleSelection(state.selectedPublicBankIds, id);
    render();
  }
  if (action === "select-all-public-banks") {
    state.publicBanks.forEach((bank) => state.selectedPublicBankIds.add(bank.id));
    render();
  }
  if (action === "clear-public-bank-selection") {
    state.selectedPublicBankIds.clear();
    state.publicBankBulkMode = false;
    render();
  }
  if (action === "save-selected-public-banks") {
    await saveSelectedPublicBanks();
  }
  if (action === "open-owner") {
    await openOwnerProfile(target.dataset.username);
  }
  if (action === "sync-progress") {
    await syncCloudData();
  }
}

async function handleViewSubmit(event) {
  if (event.target.matches("#importForm")) {
    event.preventDefault();
    await importQuestionBank(new FormData(event.target));
  }
  if (event.target.matches("#bankEditForm")) {
    event.preventDefault();
    await saveBankEdit(new FormData(event.target));
  }
}

async function handleViewChange(event) {
  if (event.target.matches("#restoreFile")) {
    const file = event.target.files?.[0];
    if (file) await importBackup(file);
  }
  if (event.target.matches("#themeSelect")) {
    applyTheme(event.target.value);
  }
  if (event.target.matches("#answerFeedbackSelect")) {
    setAnswerFeedbackMode(event.target.value);
  }
}

function handleViewInput(event) {
  if (event.target.matches("#bankSearch")) {
    state.bankFilter = event.target.value.trim();
    renderBankList();
    renderBankBulkBar();
  }
  if (event.target.matches("#discoverSearch")) {
    state.discoverQuery = event.target.value.trim();
  }
  if (event.target.matches("#fillAnswer")) {
    const fillValue = cleanText(event.target.value || "");
    state.selected = fillValue ? new Set([fillValue]) : new Set();
    persistPracticeSession();
  }
}

function render() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.view);
  });

  if (state.view === "banks") renderBanks();
  if (state.view === "practice") renderPractice();
  if (state.view === "discover") renderDiscover();
  if (state.view === "wrong") renderWrong();
  if (state.view === "stats") renderStats();
  if (state.view === "settings") renderSettings();
  if (state.view === "account") renderAccount();
}

function renderBanks() {
  const banks = getFilteredBanks();
  const totalQuestions = state.banks.reduce((sum, bank) => sum + bank.questionCount, 0);
  const totalWrong = state.allProgress.filter((item) => item.wrongCount > 0).length;

  view.innerHTML = `
    <section class="desktop-columns">
      <section class="panel bank-library-panel">
        <div class="bank-head">
          <div>
            <h2>我的题库</h2>
            <p class="subtle">管理本机题库、公开题库副本和练习记录。</p>
          </div>
          <div class="actions header-actions">
            <button class="ghost-button compact-button" type="button" data-action="start-bank-bulk" ${banks.length ? "" : "disabled"}>批量</button>
            <button class="button compact-button" type="button" data-action="open-import">导入</button>
          </div>
        </div>
        <section class="metric-row bank-library-metrics">
          <div class="metric"><strong>${state.banks.length}</strong><span>题库</span></div>
          <div class="metric"><strong>${totalQuestions}</strong><span>总题数</span></div>
          <div class="metric"><strong>${totalWrong}</strong><span>错题</span></div>
        </section>
        <div class="field">
          <label for="bankSearch">搜索题库/标签</label>
          <input id="bankSearch" type="search" value="${escapeAttr(state.bankFilter)}" placeholder="输入课程、章节或标签" />
        </div>
        <div data-bank-bulk-bar>${renderBankBulkBarContent(banks)}</div>
        <div class="bank-list" data-bank-list>${renderBankListContent(banks)}</div>
      </section>
    </section>
    ${renderBankEditSheet()}
    ${renderImportSheet()}
  `;
}

function renderImportSheet() {
  if (!state.importSheetOpen) return "";
  return `
    <div class="sheet-backdrop" data-action="close-import"></div>
    <section class="edit-sheet" role="dialog" aria-modal="true" aria-labelledby="importSheetTitle">
      <form id="importForm" class="panel form-grid" autocomplete="off">
        <div class="bank-head">
          <div>
            <h2 id="importSheetTitle">导入题库</h2>
            <p class="subtle">从 Excel 新建本地题库，导入后仍停留在题库页。</p>
          </div>
          <button class="icon-button" type="button" data-action="close-import" aria-label="关闭">×</button>
        </div>
        <div class="form-grid two">
          <div class="field">
            <label for="courseName">课程</label>
            <input id="courseName" name="course" type="text" placeholder="毛概" required />
          </div>
          <div class="field">
            <label for="chapterName">章节</label>
            <input id="chapterName" name="chapter" type="text" placeholder="导论" />
          </div>
        </div>
        <div class="field">
          <label for="bankTags">标签</label>
          <input id="bankTags" name="tags" type="text" placeholder="期末, 重点, 老师题库" />
        </div>
        <div class="field">
          <label for="xlsxFile">Excel 文件</label>
          <input id="xlsxFile" name="file" type="file" accept=".xlsx" required />
        </div>
        <div class="actions edit-sheet-actions">
          <button class="ghost-button" type="button" data-action="close-import">取消</button>
          <button class="button" type="submit">导入为新题库</button>
        </div>
      </form>
    </section>
  `;
}

function renderBankList() {
  const list = view.querySelector("[data-bank-list]");
  if (!list) return;
  list.innerHTML = renderBankListContent(getFilteredBanks());
}

function renderBankBulkBar() {
  const bar = view.querySelector("[data-bank-bulk-bar]");
  if (!bar) return;
  bar.innerHTML = renderBankBulkBarContent(getFilteredBanks());
}

function renderBankBulkBarContent(banks) {
  if (!state.bankBulkMode) return "";
  const selectedCount = banks.filter((bank) => state.selectedBankIds.has(bank.id)).length;
  return `
    <div class="bulk-bar">
      <span class="subtle">已选择 ${selectedCount}/${banks.length} 个题库</span>
      <div class="actions bulk-actions">
        <button class="ghost-button" type="button" data-action="select-all-banks" ${banks.length ? "" : "disabled"}>全选</button>
        <button class="ghost-button" type="button" data-action="clear-bank-selection">完成</button>
        <button class="danger-button" type="button" data-action="delete-selected-banks" ${state.selectedBankIds.size ? "" : "disabled"}>批量删除</button>
      </div>
    </div>
  `;
}

function renderBankListContent(banks) {
  return banks.length
    ? banks.map(renderBankCard).join("")
    : renderEmpty("还没有题库", "先导入一个 Excel 题库，就能开始刷题。");
}

function renderBankCard(bank) {
  const progress = getBankProgress(bank.id);
  const accuracy = progress.done ? Math.round((progress.correct / progress.done) * 100) : 0;
  const tags = [...(bank.tags || [])].filter(Boolean);
  const course = getBankTitle(bank);
  const chapter = cleanText(bank.chapter);
  const questionCount = bank.questionCount || bank.total || 0;
  const ownerUsername = getBankOwnerUsername(bank);
  return `
    <article class="bank-card">
      <div class="bank-head bank-card-head">
        <div class="bank-title-wrap">
          <h3 class="bank-title">
            ${state.bankBulkMode ? `<label class="select-check" title="选择题库">
              <input type="checkbox" data-action="toggle-bank-selection" data-id="${bank.id}" ${state.selectedBankIds.has(bank.id) ? "checked" : ""} />
              <span></span>
            </label>` : ""}
            <span class="bank-course">${escapeHtml(course)}</span>
            ${chapter ? `<span class="bank-chapter">${escapeHtml(chapter)}</span>` : ""}
          </h3>
          <p class="bank-meta">${questionCount} 题 · 单选 ${bank.counts?.single || 0} · 多选 ${bank.counts?.multiple || 0} · 判断 ${bank.counts?.judge || 0}</p>
          ${bank.cloudId ? `<p class="bank-owner-line">由${renderOwnerLink(ownerUsername)}发布维护</p>` : ""}
        </div>
        <div class="bank-head-actions">
          ${bank.id === state.currentBankId ? `<span class="type-pill good">当前</span>` : ""}
          ${bank.cloudId ? `<span class="type-pill">公开题库</span>` : ""}
          <button class="ghost-button edit-inline-button" type="button" data-action="edit-bank" data-id="${bank.id}">编辑</button>
        </div>
      </div>
      ${tags.length ? `<div class="tag-row">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      <div class="progress-track" aria-label="完成进度">
        <div class="progress-fill" style="width:${progress.rate}%"></div>
      </div>
      <p class="bank-meta">已做 ${progress.done}/${questionCount} · 正确率 ${accuracy}% · 错题 ${progress.wrong}</p>
      <div class="actions bank-actions">
        <button class="button" type="button" data-action="select-bank" data-id="${bank.id}">开始刷题</button>
        <button class="ghost-button" type="button" data-action="open-bank" data-id="${bank.id}">设为当前</button>
        <button class="ghost-button" type="button" data-action="view-stats" data-id="${bank.id}">考试记录</button>
        ${bank.cloudId ? "" : `<button class="ghost-button" type="button" data-action="publish-bank" data-id="${bank.id}">公开发布</button>`}
        ${bank.cloudId ? `<button class="ghost-button" type="button" data-action="copy-bank-id" data-id="${bank.cloudId}">复制ID</button>` : ""}
        <button class="danger-button" type="button" data-action="delete-bank" data-id="${bank.id}">删除</button>
      </div>
    </article>
  `;
}

function renderBankEditSheet() {
  if (!state.editingBankId) return "";
  const bank = state.banks.find((item) => item.id === state.editingBankId);
  if (!bank) return "";
  const isPublicBank = Boolean(bank.cloudId);
  return `
    <div class="sheet-backdrop" data-action="close-edit-bank"></div>
    <section class="edit-sheet" role="dialog" aria-modal="true" aria-labelledby="bankEditTitle">
      <form id="bankEditForm" class="panel form-grid" autocomplete="off">
        <div class="bank-head">
          <div>
            <h2 id="bankEditTitle">编辑题库</h2>
            <p class="subtle">${isPublicBank ? "公开题库的课程和章节由发布者维护；这里只能添加本地标签。" : "课程、章节和标签会一起保存。"}</p>
          </div>
          <button class="icon-button" type="button" data-action="close-edit-bank" aria-label="关闭">×</button>
        </div>
        <input type="hidden" name="id" value="${escapeAttr(bank.id)}" />
        ${isPublicBank ? renderPublicBankTagEditor(bank) : renderLocalBankEditorFields(bank)}
        <div class="actions edit-sheet-actions">
          <button class="ghost-button" type="button" data-action="close-edit-bank">取消</button>
          <button class="button" type="submit">保存</button>
        </div>
      </form>
    </section>
  `;
}

function renderLocalBankEditorFields(bank) {
  return `
    <div class="form-grid three">
      <div class="field">
        <label for="editCourseName">课程</label>
        <input id="editCourseName" name="course" type="text" value="${escapeAttr(bank.course || getBankTitle(bank))}" required />
      </div>
      <div class="field">
        <label for="editChapterName">章节</label>
        <input id="editChapterName" name="chapter" type="text" value="${escapeAttr(bank.chapter || "")}" />
      </div>
      <div class="field">
        <label for="editBankTags">标签</label>
        <input id="editBankTags" name="tags" type="text" value="${escapeAttr((bank.tags || []).join(", "))}" />
      </div>
    </div>
  `;
}

function renderPublicBankTagEditor(bank) {
  const ownerUsername = getBankOwnerUsername(bank);
  return `
    <div class="setting-list">
      <div class="setting-row">
        <div>
          <strong>${escapeHtml(getBankTitle(bank))}</strong>
          <p class="subtle">${bank.chapter ? `章节：${escapeHtml(bank.chapter)} · ` : ""}由 @${escapeHtml(ownerUsername || "unknown")} 发布维护</p>
        </div>
        <span class="type-pill">公开题库</span>
      </div>
    </div>
    ${(bank.tags || []).length ? `<div class="tag-row">${bank.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
    <div class="field">
      <label for="editBankAddTags">添加本地标签</label>
      <input id="editBankAddTags" name="addTags" type="text" placeholder="期末, 常刷, 已保存" />
    </div>
  `;
}

function renderOwnerLink(username) {
  const value = cleanText(username) || "unknown";
  return `<button class="owner-link" type="button" data-action="open-owner" data-username="${escapeAttr(value)}">@${escapeHtml(value)}</button>`;
}

function renderDiscover() {
  const configNote = state.cloudConfigured
    ? "搜索用户名、课程、章节、标签或题库 ID。公开题库可以直接保存到本地刷。"
    : "还没有配置 Supabase，发现页会在配置后启用。";
  view.innerHTML = `
    <section class="panel discover-panel">
      <h2>发现题库</h2>
      <p class="subtle">${configNote}</p>
      <div class="field">
        <label for="discoverSearch">用户名 / 题库 ID / 课程标签</label>
        <input id="discoverSearch" type="search" value="${escapeAttr(state.discoverQuery)}" placeholder="maogai、bank_xxx、毛概" />
      </div>
      <div class="actions discover-actions">
        <button class="button" type="button" data-action="search-public" ${state.cloudConfigured ? "" : "disabled"}>搜索公开题库</button>
      </div>
    </section>
    ${state.discoverProfile ? renderProfilePreview(state.discoverProfile) : ""}
    ${!state.discoverLoading && state.publicBanks.length ? renderPublicBankBulkControls() : ""}
    <section class="bank-list">
      ${state.discoverLoading ? renderEmpty("正在搜索", "稍等一下。") : ""}
      ${!state.discoverLoading && state.publicBanks.length ? state.publicBanks.map(renderPublicBankCard).join("") : ""}
      ${!state.discoverLoading && !state.publicBanks.length ? renderEmpty("暂无结果", state.cloudConfigured ? "输入用户名或题库 ID 后搜索。" : "先在 config.js 配置 Supabase。") : ""}
    </section>
  `;
}

function renderPublicBankBulkControls() {
  if (!state.publicBankBulkMode) {
    return `
      <section class="panel bulk-bar">
        <span class="subtle">共 ${state.publicBanks.length} 个公开题库</span>
        <button class="ghost-button compact-button" type="button" data-action="start-public-bank-bulk">批量</button>
      </section>
    `;
  }
  const selectedCount = state.publicBanks.filter((bank) => state.selectedPublicBankIds.has(bank.id)).length;
  return `
    <section class="panel bulk-bar">
      <span class="subtle">已选择 ${selectedCount}/${state.publicBanks.length} 个公开题库</span>
      <div class="actions bulk-actions">
        <button class="ghost-button" type="button" data-action="select-all-public-banks">全选</button>
        <button class="ghost-button" type="button" data-action="clear-public-bank-selection">完成</button>
        <button class="button" type="button" data-action="save-selected-public-banks" ${state.selectedPublicBankIds.size ? "" : "disabled"}>批量添加</button>
      </div>
    </section>
  `;
}

function renderProfilePreview(profile) {
  return `
    <section class="panel">
      <div class="bank-head">
        <div>
          <h2>@${escapeHtml(profile.username)}</h2>
          <p class="subtle">${escapeHtml(profile.display_name || profile.username)} · ${escapeHtml(profile.bio || "这个人还没有写简介")}</p>
        </div>
      </div>
    </section>
  `;
}

function renderPublicBankCard(bank) {
  const tags = [bank.course, bank.chapter, ...(bank.tags || [])].filter(Boolean);
  const saved = findSavedPublicBank(state.banks, bank.id);
  const saveLabel = saved ? "打开本地副本" : "保存到我的题库";
  return `
    <article class="bank-card">
      <div class="bank-head">
        <div>
          <h3 class="bank-title">${escapeHtml(getBankTitle(bank))}</h3>
          <p class="bank-meta">${bank.question_count || 0} 题 · 作者 @${escapeHtml(bank.owner_username || "unknown")} · ID ${escapeHtml(bank.id)}</p>
        </div>
        <div class="bank-head-actions">
          ${state.publicBankBulkMode ? `<label class="select-check" title="选择公开题库">
            <input type="checkbox" data-action="toggle-public-bank-selection" data-id="${bank.id}" ${state.selectedPublicBankIds.has(bank.id) ? "checked" : ""} />
            <span></span>
          </label>` : ""}
          <span class="type-pill good">公开</span>
        </div>
      </div>
      ${tags.length ? `<div class="tag-row">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      <div class="actions">
        <button class="button" type="button" data-action="use-public-bank" data-id="${bank.id}">${saveLabel}</button>
        <button class="ghost-button" type="button" data-action="open-owner" data-username="${escapeAttr(bank.owner_username || "")}">看主页</button>
        <button class="ghost-button" type="button" data-action="copy-bank-id" data-id="${bank.id}">复制ID</button>
      </div>
    </article>
  `;
}

function renderAccount() {
  const bank = getCurrentBank();
  const summary = bank ? getCurrentSummary() : null;
  view.innerHTML = `
    ${renderAccountHero()}
    ${renderEmailAccountPanel()}
    ${renderProfileForm()}
    ${renderPublishedBankManager()}
    ${renderSettingsContent(bank, summary)}
    ${renderVersionPanel()}
    ${renderContributors()}
  `;
}

function renderVersionPanel() {
  const version = state.appVersion;
  const label = version.current || version.latest || "未知";
  const status = version.checking
    ? "正在检查更新"
    : version.updateAvailable
      ? `发现新版本 ${version.latest}`
      : version.error
        ? "版本检查失败"
        : "已是最新版本";
  return `
    <section class="app-version-card" aria-label="版本">
      <div>
        <span class="version-label">当前版本</span>
        <strong>${escapeHtml(label)}</strong>
        <p class="subtle">${escapeHtml(status)}</p>
      </div>
      ${version.updateAvailable ? `<button class="button small-button" type="button" data-action="refresh-app">立即更新</button>` : ""}
    </section>
  `;
}

function renderPublishedBankManager() {
  if (!state.cloudConfigured) return "";
  const username = state.cloudProfile?.username || "";
  const publishedBanks = getOwnedPublishedBanks();
  return `
    <section class="panel account-section">
      <div class="bank-head">
        <div>
          <h2>我发布的题库</h2>
          <p class="subtle">${state.cloudUser ? "公开题库在这里统一维护；题库页只展示发布者，不提供更新入口。" : "登录后可统一管理自己发布过的公开题库。"}</p>
        </div>
        ${username ? `<span class="type-pill">@${escapeHtml(username)}</span>` : ""}
      </div>
      <div class="bank-list">
        ${publishedBanks.length ? publishedBanks.map(renderPublishedBankItem).join("") : renderEmpty("暂无已发布题库", "在题库页首次公开发布后，会出现在这里统一管理。")}
      </div>
    </section>
  `;
}

function renderPublishedBankItem(bank) {
  const ownerUsername = getBankOwnerUsername(bank);
  const questionCount = bank.questionCount || bank.total || 0;
  const canManage = isOwnedPublishedBank(bank);
  return `
    <article class="list-item published-bank-item">
      <div class="bank-head">
        <div>
          <strong>${escapeHtml(getBankTitle(bank))}</strong>
          <p class="subtle">${questionCount} 题 · 发布者 @${escapeHtml(ownerUsername || "unknown")} · ${formatDateTime(bank.updatedAt || bank.createdAt)}</p>
          <p class="bank-owner-line">公开 ID ${escapeHtml(bank.cloudId || "")}</p>
        </div>
        <span class="type-pill good">公开</span>
      </div>
      <div class="actions">
        <button class="ghost-button" type="button" data-action="copy-bank-id" data-id="${bank.cloudId}">复制ID</button>
        <button class="button" type="button" data-action="update-published-bank" data-id="${bank.id}" ${canManage ? "" : "disabled"}>更新公开题库</button>
      </div>
    </article>
  `;
}

function renderCloudSyncPanel(bank, summary) {
  if (!state.cloudConfigured) return "";
  return `
    <section class="settings-subsection">
      <div class="section-label">云同步</div>
      <p class="subtle">${bank ? escapeHtml(getBankTitle(bank)) : "从云端拉取这个账号的题库，也会上传本机题库和练习记录。"}</p>
      ${bank ? `
        <div class="metric-row">
          <div class="metric compact-metric"><strong>${summary.done}</strong><span>已做</span></div>
          <div class="metric compact-metric"><strong>${summary.accuracy}%</strong><span>正确率</span></div>
          <div class="metric compact-metric"><strong>${summary.wrong}</strong><span>错题</span></div>
        </div>
      ` : ""}
      <div class="actions" style="margin-top:12px;">
        <button class="ghost-button" type="button" data-action="sync-progress" ${state.cloudUser ? "" : "disabled"}>同步题库与记录</button>
      </div>
    </section>
  `;
}

function renderAccountHero() {
  const label = state.cloudUser ? (state.cloudProfile?.display_name || state.cloudProfile?.username || state.cloudUser.email || "已登录") : "本地学习";
  const subtitle = state.cloudUser
    ? state.cloudUser.email || "账号已连接"
    : state.cloudConfigured
      ? "登录后可发布题库和同步记录"
      : "当前为本地模式，题库和练习记录保存在本机";
  const badge = state.cloudUser ? "已登录" : state.cloudConfigured ? "可登录" : "本地";
  return `
    <section class="panel account-hero">
      <div class="account-main">
        <div class="account-avatar">${escapeHtml(getAvatarText(label))}</div>
        <div>
          <h2>${escapeHtml(label)}</h2>
          <p class="subtle">${escapeHtml(subtitle)}</p>
        </div>
      </div>
      <span class="type-pill ${state.cloudUser ? "good" : ""}">${escapeHtml(badge)}</span>
    </section>
  `;
}

function renderEmailAccountPanel() {
  if (!state.cloudConfigured) {
    return `
      <section class="panel account-section">
        <h2>账号</h2>
        <div class="setting-list">
          <div class="setting-row">
            <div>
              <strong>本地模式</strong>
              <p class="subtle">云端尚未配置。填写 <code>config.js</code> 后可启用登录、云同步和题库广场。</p>
            </div>
          </div>
        </div>
      </section>
    `;
  }
  if (!state.cloudUser) {
    return `
      <section class="panel account-section form-grid">
        <h2>登录</h2>
        <p class="subtle">使用 GitHub 登录后可发布题库和同步记录。邮箱不会公开展示。</p>
        <div class="actions account-actions">
          <button class="button" type="button" data-action="sign-in-provider" data-provider="github">使用 GitHub 登录</button>
        </div>
        <p class="subtle">备用方式：输入邮箱后会发送登录链接。本项目不设置密码。</p>
        <div class="field">
          <label for="loginEmail">邮箱</label>
          <input id="loginEmail" type="email" placeholder="you@example.com" />
        </div>
        <div class="actions account-actions">
          <button class="button" type="button" data-action="send-login-link">发送登录链接</button>
        </div>
      </section>
    `;
  }
  return `
    <section class="panel account-section">
      <h2>账号</h2>
      <div class="setting-list">
        <div class="setting-row">
          <div>
            <strong>邮箱</strong>
            <p class="subtle">${escapeHtml(state.cloudUser.email || state.cloudUser.id)}</p>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <strong>云端接口</strong>
            <p class="subtle">版本 ${escapeHtml(CLOUD_API_VERSION)}</p>
          </div>
          <button class="danger-button" type="button" data-action="sign-out">退出登录</button>
        </div>
      </div>
    </section>
  `;
}

function renderContributors() {
  return `
    <section class="authors-footer" aria-label="作者">
      <span class="authors-label">作者</span>
      <div class="authors-line">
        <a class="author-link" href="https://github.com/liziyaaa" target="_blank" rel="noopener noreferrer">
          <img class="author-avatar" src="https://github.com/liziyaaa.png?size=64" alt="" loading="lazy" />
          <span>liziyaaa</span>
        </a>
        <span class="authors-separator">和</span>
        <a class="author-link" href="https://github.com/kqrekybjinn" target="_blank" rel="noopener noreferrer">
          <img class="author-avatar" src="https://github.com/kqrekybjinn.png?size=64" alt="" loading="lazy" />
          <span>kqrekybjinn</span>
        </a>
      </div>
    </section>
  `;
}

function renderProfileForm() {
  if (!state.cloudConfigured || !state.cloudUser) return "";
  const profile = state.cloudProfile || {};
  return `
    <section class="panel form-grid account-section">
      <h2>个人主页</h2>
      <p class="subtle">发布题库前需要设置公开用户名和昵称。公开题库会展示这些署名信息，但不会展示邮箱。</p>
      <div class="form-grid two">
        <div class="field">
          <label for="profileUsername">用户名</label>
          <input id="profileUsername" type="text" value="${escapeAttr(profile.username || "")}" placeholder="只建议英文、数字、下划线" />
        </div>
        <div class="field">
          <label for="profileDisplay">昵称</label>
          <input id="profileDisplay" type="text" value="${escapeAttr(profile.display_name || "")}" placeholder="小李爱刷题" />
        </div>
      </div>
      <div class="field">
        <label for="profileBio">简介</label>
        <input id="profileBio" type="text" value="${escapeAttr(profile.bio || "")}" placeholder="毛概/马原题库整理中" />
      </div>
      <div class="actions">
        <button class="button" type="button" data-action="save-profile">保存主页资料</button>
        ${profile.username ? `<button class="ghost-button" type="button" data-action="open-owner" data-username="${escapeAttr(profile.username)}">查看我的公开主页</button>` : ""}
      </div>
    </section>
  `;
}

function renderPractice() {
  const bank = getCurrentBank();
  if (!bank) {
    view.innerHTML = renderEmpty("还没有选择题库", "请先在题库页导入或选择一个题库。");
    return;
  }

  const summary = getCurrentSummary();
  const current = state.queue[state.queueIndex];
  if (state.lastExamRecord) {
    view.innerHTML = renderExamSummary(state.lastExamRecord);
    return;
  }
  const savedSession = current ? null : getValidPracticeSession();
  const startButtonLabel = current || savedSession ? "重新开始" : "开始练习";
  const modes = [
    ["sequential", "顺序"],
    ["random", "随机"],
    ["wrong", "错题"],
    ["favorite", "收藏"],
    ["unanswered", "未做"],
  ];

  view.innerHTML = `
    <section class="panel">
      <div class="bank-head">
        <div>
          <h2>${escapeHtml(getBankTitle(bank))}</h2>
          <p class="subtle">已做 ${summary.done}/${state.questions.length} · 正确率 ${summary.accuracy}% · 错题 ${summary.wrong}</p>
        </div>
        <div class="practice-mode-pills">
          <span class="type-pill">${escapeHtml(queueModeName(state.practiceMode))}</span>
          <span class="type-pill warn">${escapeHtml(sessionModeName(state.sessionMode))}</span>
          ${state.sessionMode === "practice" ? `<span class="type-pill">${escapeHtml(answerFeedbackModeName(state.answerFeedbackMode))}</span>` : ""}
        </div>
      </div>
      <p class="subtle">练习范围</p>
      <div class="chip-row">
        ${modes.map(([mode, label]) => `<button class="mode-chip ${state.practiceMode === mode ? "is-active" : ""}" type="button" data-action="set-mode" data-mode="${mode}">${label}</button>`).join("")}
      </div>
      <div class="actions practice-actions">
        <button class="ghost-button" type="button" data-action="view-stats" data-id="${bank.id}">考试记录</button>
        <button class="ghost-button" type="button" data-action="start-practice">${startButtonLabel}</button>
      </div>
    </section>
    ${current ? renderQuestionCard(current) : renderQueueEmpty(savedSession)}
  `;
}

function renderQueueEmpty(savedSession = getValidPracticeSession()) {
  const count = buildQueue(state.practiceMode).length;
  const hasResume = Boolean(savedSession);
  const resumeText = hasResume
    ? `${sessionModeName(savedSession.sessionMode)} · ${queueModeName(savedSession.mode)} · 第 ${savedSession.queueIndex + 1}/${savedSession.queueIds.length} 题`
    : "";
  return `
    <section class="empty-state practice-start">
      <h2>${hasResume ? "继续上次练习" : count ? "准备开始" : "这个模式暂无题目"}</h2>
      <p>${hasResume ? `已保存上次进度：${resumeText}。` : count ? `当前模式有 ${count} 道题。` : "可以换一个模式，或者先完成一些题目。 "}</p>
      <div class="start-mode-block">
        <p class="subtle">本次模式</p>
        <div class="chip-row">
          ${["practice", "exam"].map((mode) => `<button class="mode-chip ${state.sessionMode === mode ? "is-active" : ""}" type="button" data-action="set-session-mode" data-mode="${mode}">${sessionModeName(mode)}</button>`).join("")}
        </div>
        ${state.sessionMode === "practice" ? `<p class="subtle">当前反馈：${escapeHtml(answerFeedbackModeName(state.answerFeedbackMode))}。多选题始终需要提交后显示答案。</p>` : `<p class="subtle">考试模式可提前交卷，未作答题目记为未答，不加入错题本。</p>`}
      </div>
      <div class="actions question-actions">
        ${hasResume && count ? `<button class="ghost-button" type="button" data-action="start-practice">重新开始</button>` : ""}
        ${hasResume ? `<button class="button primary-action" type="button" data-action="resume-practice">继续上次</button>` : count ? `<button class="button primary-action" type="button" data-action="start-practice">开始练习</button>` : ""}
      </div>
    </section>
  `;
}

function renderQuestionCard(question) {
  const progress = getProgress(question.id);
  const progressText = `${state.queueIndex + 1}/${state.queue.length}`;
  const percent = state.queue.length ? Math.round(((state.queueIndex + 1) / state.queue.length) * 100) : 0;
  const result = state.lastResult;
  const isExam = state.sessionMode === "exam";
  const isLastQuestion = state.queueIndex + 1 >= state.queue.length;
  return `
    <article class="question-card">
      <div class="question-toolbar">
        <div class="chip-row">
          <span class="type-pill">${typeLabel(question.type)}</span>
          <button class="progress-trigger" type="button" data-action="toggle-question-picker" aria-expanded="${state.questionPickerOpen ? "true" : "false"}" aria-haspopup="dialog">
            <span>${progressText}</span>
            <span class="progress-caret">${state.questionPickerOpen ? "▴" : "▾"}</span>
          </button>
        </div>
        <button class="icon-button" type="button" data-action="toggle-favorite" data-question-id="${question.id}" title="收藏">
          ${progress.favorite ? "★" : "☆"}
        </button>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>
      <p class="stem">${escapeHtml(question.stem)}</p>
      ${question.type === "fill" ? renderFillInput() : `<div class="option-list">${question.options.map((option) => renderOption(question, option)).join("")}</div>`}
      <div class="actions question-actions">
        <button class="ghost-button" type="button" data-action="start-practice">重新开始</button>
        ${renderQuestionPrimaryAction({ isExam, isLastQuestion })}
      </div>
      ${state.submitted && result && !isExam ? renderResult(question, result) : ""}
    </article>
    ${renderQuestionPicker()}
  `;
}

function renderQuestionPrimaryAction({ isExam, isLastQuestion }) {
  if (isExam) {
    return isLastQuestion
      ? `<button class="button primary-action" type="button" data-action="finish-exam">提交考试</button>`
      : `
        <button class="ghost-button" type="button" data-action="finish-exam">提前交卷</button>
        <button class="button primary-action" type="button" data-action="next-question">下一题</button>
      `;
  }
  return state.submitted
    ? `<button class="button primary-action" type="button" data-action="next-question">${isLastQuestion ? "完成本组" : "下一题"}</button>`
    : `<button class="button primary-action" type="button" data-action="submit-answer">提交答案</button>`;
}

function renderQuestionPicker() {
  if (!state.questionPickerOpen || !state.queue.length) return "";
  const groups = groupQueueByType();
  return `
    <div class="sheet-backdrop" data-action="close-question-picker"></div>
    <section class="question-picker-sheet" role="dialog" aria-modal="true" aria-labelledby="questionPickerTitle">
      <div class="panel question-picker-panel">
        <div class="bank-head">
          <div>
            <h2 id="questionPickerTitle">题目目录</h2>
            <p class="subtle">按题型快速跳转，当前题会高亮显示。</p>
          </div>
          <button class="icon-button" type="button" data-action="close-question-picker" aria-label="关闭">×</button>
        </div>
        <div class="question-picker-groups">
          ${groups.map((group) => `
            <section class="question-picker-group">
              <div class="question-picker-head">
                <strong>${escapeHtml(typeLabel(group.type))}</strong>
                <span class="subtle">${group.items.length} 题</span>
              </div>
              <div class="question-picker-grid">
                ${group.items.map(({ question, index }) => renderQuestionJumpButton(question, index)).join("")}
              </div>
            </section>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderQuestionJumpButton(question, index) {
  const progress = getProgress(question.id);
  const className = [
    "question-jump-button",
    index === state.queueIndex ? "is-current" : "",
    progress.answered ? (progress.correct ? "is-done" : "is-wrong") : "",
  ].filter(Boolean).join(" ");
  return `
    <button class="${className}" type="button" data-action="jump-question" data-index="${index}">
      ${question.order}
    </button>
  `;
}

function groupQueueByType() {
  const groups = new Map();
  state.queue.forEach((question, index) => {
    const key = question.type;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ question, index });
  });
  return ["single", "multiple", "judge", "fill"]
    .filter((type) => groups.has(type))
    .map((type) => ({ type, items: groups.get(type) }));
}

function renderOption(question, option) {
  const value = option.value || option.label;
  const selected = state.selected.has(value);
  const shouldRevealAnswer = state.submitted && state.sessionMode === "practice";
  const correct = isOptionCorrect(question, option);
  const wrongSelected = shouldRevealAnswer && selected && !correct;
  const className = [
    "option-button",
    selected ? "is-selected" : "",
    shouldRevealAnswer && correct ? "is-correct" : "",
    wrongSelected ? "is-wrong" : "",
  ].filter(Boolean).join(" ");
  return `
    <button class="${className}" type="button" data-action="choose-option" data-value="${escapeAttr(value)}">
      <span class="option-label">${escapeHtml(option.label)}</span>
      <span class="option-text">${escapeHtml(option.text)}</span>
    </button>
  `;
}

function renderFillInput() {
  const value = [...state.selected][0] || "";
  return `
    <div class="field">
      <label for="fillAnswer">填写答案</label>
      <input id="fillAnswer" type="text" value="${escapeAttr(value)}" placeholder="输入后提交" ${state.submitted ? "disabled" : ""} />
    </div>
  `;
}

function renderResult(question, result) {
  const answerText = getAnswerDisplay(question);
  const progress = getProgress(question.id);
  const wrongAction = result.correct
    ? ""
    : `<div class="actions result-actions">${
        progress.wrongCount > 0
          ? `<button class="ghost-button" type="button" disabled>已在错题本</button>`
          : `<button class="ghost-button" type="button" data-action="add-wrong" data-question-id="${question.id}">加入错题本</button>`
      }</div>`;
  return `
    <section class="result-box ${result.correct ? "good" : "bad"}">
      <div>正确答案：${escapeHtml(answerText)}</div>
      <div class="explanation">${escapeHtml(question.analysis || "暂无解析。")}</div>
      ${wrongAction}
    </section>
  `;
}

function renderExamQuestionStatus(result) {
  return `
    <section class="result-box ${result.correct ? "good" : "bad"}">
      <div>${result.correct ? "回答正确" : "回答错误"}</div>
    </section>
  `;
}

function renderWrong() {
  if (!state.reviewLoading && !state.reviewLoaded) {
    loadReviewGroups().then(() => {
      if (state.view === "wrong") renderWrong();
    });
  }
  const totalWrong = state.reviewGroups.reduce((sum, group) => sum + group.wrongQuestions.length, 0);
  const totalFavorite = state.reviewGroups.reduce((sum, group) => sum + group.favoriteQuestions.length, 0);
  view.innerHTML = `
    <section class="panel">
      <h2>错题与收藏</h2>
      <p class="subtle">按题库整理练习过的错题和收藏题，点击题库可展开明细。</p>
      <div class="metric-row">
        <div class="metric compact-metric"><strong>${totalWrong}</strong><span>错题</span></div>
        <div class="metric compact-metric"><strong>${totalFavorite}</strong><span>收藏</span></div>
        <div class="metric compact-metric"><strong>${state.reviewGroups.length}</strong><span>题库</span></div>
      </div>
    </section>
    <section class="bank-list">
      ${state.reviewLoading ? renderEmpty("正在整理", "正在读取本地题库记录。") : ""}
      ${!state.reviewLoading && state.reviewGroups.length ? state.reviewGroups.map(renderReviewGroup).join("") : ""}
      ${!state.reviewLoading && !state.reviewGroups.length ? renderEmpty("暂无错题和收藏", "答错或收藏过的题会按题库出现在这里。") : ""}
    </section>
  `;
}

function renderReviewGroup(group) {
  const wrongCount = group.wrongQuestions.length;
  const favoriteCount = group.favoriteQuestions.length;
  const expanded = state.expandedReviewBankIds.has(group.bank.id);
  return `
    <article class="panel review-bank-card">
      <button class="review-bank-toggle" type="button" data-action="toggle-review-bank" data-id="${escapeAttr(group.bank.id)}" aria-expanded="${expanded ? "true" : "false"}">
        <div>
          <h3>${escapeHtml(getBankTitle(group.bank))}</h3>
          <p class="subtle">${wrongCount} 道错题 · ${favoriteCount} 道收藏题</p>
        </div>
        <span class="type-pill">${expanded ? "收起" : "展开"}</span>
      </button>
      <div class="actions">
        <button class="button" type="button" data-action="practice-wrong" data-id="${escapeAttr(group.bank.id)}" ${wrongCount ? "" : "disabled"}>重练错题</button>
        <button class="ghost-button" type="button" data-action="practice-favorite" data-id="${escapeAttr(group.bank.id)}" ${favoriteCount ? "" : "disabled"}>练习收藏</button>
        <button class="ghost-button" type="button" data-action="export-review-bank" data-id="${escapeAttr(group.bank.id)}">导出</button>
      </div>
      ${expanded && wrongCount ? `<div class="review-section"><div class="section-label">错题</div>${group.wrongQuestions.map((item) => renderReviewItem(item, "wrong")).join("")}</div>` : ""}
      ${expanded && favoriteCount ? `<div class="review-section"><div class="section-label">收藏</div>${group.favoriteQuestions.map((item) => renderReviewItem(item, "favorite")).join("")}</div>` : ""}
    </article>
  `;
}

function renderReviewItem(item, kind) {
  const { question, progress } = item;
  const label = kind === "wrong" ? `错 ${progress.wrongCount} 次` : "已收藏";
  const pillClass = kind === "wrong" ? "warn" : "good";
  return `
    <article class="list-item compact-review-item">
      <div class="chip-row">
        <span class="type-pill">${typeLabel(question.type)}</span>
        <span class="type-pill ${pillClass}">${escapeHtml(label)}</span>
      </div>
      <p>${escapeHtml(question.stem)}</p>
      <p class="subtle">正确答案：${escapeHtml(getAnswerDisplay(question))}</p>
      ${kind === "wrong" ? `<div class="actions"><button class="ghost-button" type="button" data-action="master-question" data-question-id="${question.id}">标记掌握</button></div>` : ""}
    </article>
  `;
}

function renderStats() {
  const bank = getCurrentBank();
  if (!bank) {
    view.innerHTML = renderEmpty("暂无统计", "选择题库后可以查看刷题统计。");
    return;
  }
  const summary = getCurrentSummary();
  const examRecords = getCurrentExamRecords();
  const typeRows = ["single", "multiple", "judge", "fill"].map((type) => {
    const items = state.questions.filter((question) => question.type === type);
    const progressItems = items.map((question) => getProgress(question.id));
    const done = progressItems.filter((item) => item.answered).length;
    const correct = progressItems.filter((item) => item.correct).length;
    const rate = done ? Math.round((correct / done) * 100) : 0;
    return { type, total: items.length, done, rate };
  }).filter((row) => row.total > 0);

  view.innerHTML = `
    <section class="panel">
      <h2>统计</h2>
      <p class="subtle">${escapeHtml(getBankTitle(bank))}</p>
      <div class="metric-row">
        <div class="metric"><strong>${summary.done}</strong><span>已做</span></div>
        <div class="metric"><strong>${summary.accuracy}%</strong><span>正确率</span></div>
        <div class="metric"><strong>${summary.wrong}</strong><span>错题</span></div>
      </div>
    </section>
    <section class="panel">
      <h2>题型表现</h2>
      <div class="bank-list">
        ${typeRows.map((row) => `
          <div class="list-item">
            <div class="bank-head">
              <strong>${typeLabel(row.type)}</strong>
              <span class="subtle">${row.done}/${row.total} · ${row.rate}%</span>
            </div>
            <div class="progress-track"><div class="progress-fill" style="width:${row.total ? Math.round((row.done / row.total) * 100) : 0}%"></div></div>
          </div>
        `).join("")}
      </div>
    </section>
    <section class="panel">
      <h2>考试记录</h2>
      <div class="bank-list">
        ${examRecords.length ? examRecords.map(renderExamRecordItem).join("") : renderEmpty("暂无考试记录", "切换到考试模式并提交后，会在这里留下记录。")}
      </div>
    </section>
  `;
}

function renderExamRecordItem(record) {
  return `
    <article class="list-item">
      <div class="bank-head">
        <div>
          <strong>${record.accuracy}%</strong>
          <p class="subtle">${formatDateTime(record.createdAt)} · ${record.correct}/${record.total} 正确 · 错 ${record.wrong}</p>
        </div>
        <button class="ghost-button" type="button" data-action="add-exam-wrongs" data-id="${record.id}" ${record.wrong ? "" : "disabled"}>错题入本</button>
      </div>
    </article>
  `;
}

function renderSettings() {
  view.innerHTML = `
    ${renderSettingsContent()}
  `;
}

function renderSettingsContent(bank = getCurrentBank(), summary = bank ? getCurrentSummary() : null) {
  return `
    <section class="panel account-section">
      <h2>设置与备份</h2>
      <p class="subtle">题库和练习记录保存在本机 IndexedDB。建议定期导出备份，避免清理 Safari 数据后丢失。</p>
      <div class="setting-list">
        <div class="setting-row">
          <div>
            <strong>练习反馈</strong>
            <p class="subtle">只影响练习模式；多选题始终需要提交后显示答案。</p>
          </div>
          <div class="setting-control">
            <select id="answerFeedbackSelect" aria-label="答题反馈模式">
              <option value="instant" ${state.answerFeedbackMode === "instant" ? "selected" : ""}>直接显示答案</option>
              <option value="submit" ${state.answerFeedbackMode === "submit" ? "selected" : ""}>提交后显示答案</option>
            </select>
          </div>
        </div>
        <div class="setting-row">
          <div>
            <strong>主题</strong>
            <p class="subtle">切换应用配色，只保存在本机。</p>
          </div>
          <div class="setting-control">
            <select id="themeSelect" aria-label="主题">
              <option value="default" ${state.appTheme === "default" ? "selected" : ""}>默认</option>
              <option value="tokyonight" ${state.appTheme === "tokyonight" ? "selected" : ""}>Tokyo Night</option>
              <option value="high-contrast" ${state.appTheme === "high-contrast" ? "selected" : ""}>高对比</option>
              <option value="topaz" ${state.appTheme === "topaz" ? "selected" : ""}>蓝色托帕石</option>
              <option value="nord" ${state.appTheme === "nord" ? "selected" : ""}>Nord</option>
              <option value="solarized" ${state.appTheme === "solarized" ? "selected" : ""}>Solarized Light</option>
            </select>
          </div>
        </div>
      </div>
      ${renderCloudSyncPanel(bank, summary)}
      <div class="grid">
        <button class="button" type="button" data-action="export-backup">导出全部备份</button>
        <div class="field">
          <label for="restoreFile">导入备份 JSON</label>
          <input id="restoreFile" type="file" accept=".json,application/json" />
        </div>
        <button class="danger-button" type="button" data-action="clear-all">清空所有数据</button>
      </div>
    </section>
  `;
}

async function importQuestionBank(formData) {
  const file = formData.get("file");
  const course = cleanText(formData.get("course"));
  const chapter = cleanText(formData.get("chapter"));
  const tags = splitTags(formData.get("tags"));
  if (!file || !file.name) {
    showToast("请选择 Excel 文件");
    return;
  }
  if (!course) {
    showToast("请先填写课程");
    return;
  }

  try {
    showToast("正在解析 Excel...");
    const rawRows = await readXlsxRows(file);
    const questions = normalizeRows(rawRows);
    if (!questions.length) throw new Error("没有识别到有效题目");

    const bankId = createId("bank");
    const now = new Date().toISOString();
    const bank = {
      id: bankId,
      name: buildBankName(course, chapter, file.name),
      course,
      chapter,
      tags,
      questionCount: questions.length,
      counts: countQuestionTypes(questions),
      createdAt: now,
      updatedAt: now,
      lastStudiedAt: "",
    };
    const storedQuestions = questions.map((question, index) => ({
      ...question,
      id: createId("q"),
      bankId,
      order: index + 1,
      createdAt: now,
    }));

    await saveBankWithQuestions(bank, storedQuestions);
    state.currentBankId = bankId;
    localStorage.setItem(CURRENT_BANK_KEY, bankId);
    await refreshBanks();
    await loadCurrentBank();
    resetPracticeQueue();
    state.importSheetOpen = false;
    state.view = "banks";
    showToast(`已导入 ${questions.length} 道题`);
    render();
  } catch (error) {
    console.error(error);
    showToast(`导入失败：${error.message || error}`);
  }
}

function routeToAccountWithMessage(message) {
  state.view = "account";
  showToast(message);
  render();
}

async function publishLocalBank(bankId) {
  try {
    const blocker = getPublishBlocker({
      cloudConfigured: state.cloudConfigured,
      cloudUser: state.cloudUser,
      cloudProfile: state.cloudProfile,
    });
    if (blocker) {
      routeToAccountWithMessage(blocker);
      return;
    }
    const bank = state.banks.find((item) => item.id === bankId);
    if (!bank) throw new Error("找不到题库");
    if (bank.cloudId) throw new Error("这个题库已经公开发布，请到“我的-我发布的题库”中更新");
    const questions = await getByIndex(STORE_QUESTIONS, "bankId", bankId);
    if (!questions.length) throw new Error("题库里没有题目");
    const message = `确定公开发布“${getBankTitle(bank)}”吗？\n\n公开后，题目、正确答案和解析都会被其他人搜索、查看和保存。你的邮箱不会公开展示，公开署名为 @${state.cloudProfile.username}。`;
    if (!confirm(message)) return;
    showToast("正在发布题库...");
    const cloudId = await cloud.publishBank(bank, questions.sort((a, b) => a.order - b.order), state.cloudProfile, "public");
    await putMany(STORE_QUESTIONS, questions.map((question) => ({
      ...question,
      cloudQuestionId: `${cloudId}_${question.order}`,
    })));
    const updated = {
      ...bank,
      cloudId,
      visibility: "public",
      ownerUsername: state.cloudProfile.username,
      updatedAt: new Date().toISOString(),
    };
    await putRecord(STORE_BANKS, updated);
    await refreshBanks();
    showToast(`已公开发布，题库 ID：${cloudId}`);
    render();
  } catch (error) {
    console.error(error);
    showToast(`发布失败：${error.message || error}`);
  }
}

async function updatePublishedBank(bankId) {
  try {
    const blocker = getPublishBlocker({
      cloudConfigured: state.cloudConfigured,
      cloudUser: state.cloudUser,
      cloudProfile: state.cloudProfile,
    });
    if (blocker) {
      routeToAccountWithMessage(blocker);
      return;
    }
    const bank = state.banks.find((item) => item.id === bankId);
    if (!bank) throw new Error("找不到题库");
    if (!bank.cloudId) throw new Error("这个题库还没有公开发布");
    if (!isOwnedPublishedBank(bank)) throw new Error("只有发布者可以更新这个公开题库");
    const questions = await getByIndex(STORE_QUESTIONS, "bankId", bankId);
    if (!questions.length) throw new Error("题库里没有题目");
    const message = `确定更新公开题库“${getBankTitle(bank)}”吗？\n\n这会覆盖别人搜索到的公开版本，包括题目、正确答案和解析。公开署名仍为 @${state.cloudProfile.username}。`;
    if (!confirm(message)) return;
    showToast("正在更新公开题库...");
    const cloudId = await cloud.publishBank(bank, questions.sort((a, b) => a.order - b.order), state.cloudProfile, "public");
    await putMany(STORE_QUESTIONS, questions.map((question) => ({
      ...question,
      cloudQuestionId: `${cloudId}_${question.order}`,
    })));
    const updated = {
      ...bank,
      cloudId,
      visibility: "public",
      ownerUsername: state.cloudProfile.username,
      updatedAt: new Date().toISOString(),
    };
    await putRecord(STORE_BANKS, updated);
    await refreshBanks();
    showToast("公开题库已更新");
    render();
  } catch (error) {
    console.error(error);
    showToast(`更新失败：${error.message || error}`);
  }
}

async function sendLoginLink() {
  try {
    const email = cleanText(document.querySelector("#loginEmail")?.value || "");
    if (!email) throw new Error("请输入邮箱");
    await cloud.sendMagicLink(email);
    showToast("登录链接已发送，请去邮箱点击");
  } catch (error) {
    console.error(error);
    showToast(`发送失败：${error.message || error}`);
  }
}

async function signInProvider(provider) {
  try {
    cloud.signInWithOAuth(provider);
  } catch (error) {
    console.error(error);
    showToast(`登录失败：${error.message || error}`);
  }
}

async function signOutCloud() {
  await cloud.signOut();
  state.cloudUser = null;
  state.cloudProfile = null;
  showToast("已退出登录");
  render();
}

async function saveProfile() {
  try {
    if (!state.cloudUser) throw new Error("请先登录");
    const username = normalizeUsername(document.querySelector("#profileUsername")?.value || "");
    if (!username) throw new Error("用户名不能为空");
    const displayName = cleanText(document.querySelector("#profileDisplay")?.value || "");
    if (!displayName) throw new Error("昵称不能为空");
    const profile = {
      id: state.cloudUser.id,
      username,
      display_name: displayName,
      bio: cleanText(document.querySelector("#profileBio")?.value || ""),
    };
    state.cloudProfile = await cloud.upsertProfile(profile);
    showToast("主页资料已保存");
    render();
  } catch (error) {
    console.error(error);
    showToast(`保存失败：${error.message || error}`);
  }
}

async function searchPublicBanks() {
  if (!state.cloudConfigured) {
    showToast("请先配置 Supabase");
    return;
  }
  state.discoverLoading = true;
  state.publicBanks = [];
  state.selectedPublicBankIds.clear();
  state.publicBankBulkMode = false;
  state.discoverProfile = null;
  render();
  try {
    const query = state.discoverQuery;
    const [banks, profile] = await Promise.all([
      cloud.searchPublicBanks(query),
      query ? cloud.getProfileByUsername(query).catch(() => null) : Promise.resolve(null),
    ]);
    state.publicBanks = banks || [];
    state.discoverProfile = profile;
    if (profile) {
      const userBanks = await cloud.listUserPublicBanks(profile.username);
      const byId = new Map([...state.publicBanks, ...userBanks].map((bank) => [bank.id, bank]));
      state.publicBanks = [...byId.values()];
    }
    showToast(`找到 ${state.publicBanks.length} 个公开题库`);
  } catch (error) {
    console.error(error);
    showToast(`搜索失败：${error.message || error}`);
  } finally {
    state.discoverLoading = false;
    render();
  }
}

async function openOwnerProfile(username) {
  if (!username) return;
  state.view = "discover";
  state.discoverQuery = username;
  await searchPublicBanks();
}

async function usePublicBank(bankId) {
  try {
    showToast("正在保存公开题库...");
    const saved = await savePublicBankToLocal(bankId);
    if (saved.skipped) {
      setCurrentBank(saved.localBankId, true);
      showToast("这个公开题库已经保存过，可在题库页打开本地副本");
      render();
      return;
    }
    setCurrentBank(saved.localBankId, true);
    await refreshBanks();
    resetPracticeQueue();
    state.selectedPublicBankIds.delete(bankId);
    showToast(saved.updated ? `题库已更新为最新版本，共 ${saved.questionCount} 道题` : `已保存 ${saved.questionCount} 道题，可在题库页开始练习`);
    render();
  } catch (error) {
    console.error(error);
    showToast(`保存失败：${error.message || error}`);
  }
}

async function savePublicBankToLocal(bankId) {
  const payload = await cloud.getPublicBank(bankId);
  if (!payload) throw new Error("找不到公开题库");
  const existing = findSavedPublicBank(state.banks, payload.bank.id);
  if (existing) {
    const existingQuestions = await getByIndex(STORE_QUESTIONS, "bankId", existing.id);
    if (areLocalQuestionsSameAsCloud(existingQuestions, payload.questions || [])) {
      return { skipped: true, localBankId: existing.id, questionCount: existing.questionCount || existing.total || 0 };
    }
    const now = new Date().toISOString();
    const existingQuestionIds = new Map(existingQuestions.map((question) => [question.cloudQuestionId, question.id]));
    const { localBank, localQuestions } = mapPublicBankToLocal({
      payload,
      localBankId: existing.id,
      now,
      createQuestionId: (cloudQuestion) => existingQuestionIds.get(cloudQuestion.id) || createId("q"),
      buildBankName,
      countQuestionTypes,
    });
    await replaceBankWithQuestions({
      ...localBank,
      tags: [...new Set([...(localBank.tags || []), ...(existing.tags || [])].map(cleanText).filter(Boolean))],
      createdAt: existing.createdAt || localBank.createdAt,
      lastStudiedAt: existing.lastStudiedAt || "",
    }, localQuestions);
    return { skipped: false, updated: true, localBankId: existing.id, questionCount: localQuestions.length };
  }
  const localBankId = createId("bank");
  const now = new Date().toISOString();
  const { localBank, localQuestions } = mapPublicBankToLocal({
    payload,
    localBankId,
    now,
    createQuestionId: () => createId("q"),
    buildBankName,
    countQuestionTypes,
  });
  await saveBankWithQuestions(localBank, localQuestions);
  if (state.cloudUser) {
    await cloud.savePublicBank(payload.bank.id, localBankId);
  }
  return { skipped: false, localBankId, questionCount: localQuestions.length };
}

async function saveSelectedPublicBanks() {
  const ids = [...state.selectedPublicBankIds].filter((id) => state.publicBanks.some((bank) => bank.id === id));
  if (!ids.length) {
    showToast("请先选择公开题库");
    return;
  }
  try {
    showToast(`正在添加 ${ids.length} 个公开题库...`);
    let savedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let lastLocalBankId = "";
    for (const id of ids) {
      const result = await savePublicBankToLocal(id);
      if (result.skipped) skippedCount += 1;
      else if (result.updated) updatedCount += 1;
      else savedCount += 1;
      lastLocalBankId = result.localBankId || lastLocalBankId;
    }
    state.selectedPublicBankIds.clear();
    state.publicBankBulkMode = false;
    await refreshBanks();
    if (lastLocalBankId) setCurrentBank(lastLocalBankId, true);
    resetPracticeQueue();
    render();
    showToast(`批量添加完成：新增 ${savedCount} 个，更新 ${updatedCount} 个，已存在 ${skippedCount} 个`);
  } catch (error) {
    console.error(error);
    showToast(`批量添加失败：${error.message || error}`);
  }
}

async function syncCloudData() {
  try {
    if (!state.cloudUser) throw new Error("请先登录");
    showToast("正在同步题库与记录...");
    const result = {
      uploadedBanks: 0,
      savedBanks: 0,
      progressRows: 0,
      downloadedBanks: 0,
    };

    for (const bank of [...state.banks]) {
      const synced = await syncOneBank(bank);
      result.uploadedBanks += synced.uploadedBank ? 1 : 0;
      result.savedBanks += synced.savedBank ? 1 : 0;
      result.progressRows += synced.progressRows;
    }

    result.downloadedBanks = await pullMissingCloudBanks();
    await refreshBanks();
    if (state.currentBankId) await loadCurrentBank();
    resetPracticeQueue();
    render();
    showToast(`已同步：上传 ${result.uploadedBanks} 个，下载 ${result.downloadedBanks} 个，保存关系 ${result.savedBanks} 个，记录 ${result.progressRows} 条`);
  } catch (error) {
    console.error(error);
    showToast(`同步失败：${error.message || error}`);
  }
}

async function pullMissingCloudBanks() {
  const knownCloudIds = new Set((await getAll(STORE_BANKS)).map((bank) => bank.cloudId).filter(Boolean));
  let downloaded = 0;
  const ownedBanks = await cloud.listMyCloudBanks();
  for (const bank of ownedBanks || []) {
    if (knownCloudIds.has(bank.id)) continue;
    const payload = await cloud.getBank(bank.id);
    if (payload) {
      await saveCloudBankPayload(payload, createId("bank"), payload.bank.visibility || "private");
      knownCloudIds.add(bank.id);
      downloaded += 1;
    }
  }

  const savedRelations = await cloud.listMySavedBankRelations();
  for (const relation of savedRelations || []) {
    if (knownCloudIds.has(relation.bank_id)) continue;
    const payload = await cloud.getPublicBank(relation.bank_id);
    if (payload) {
      await saveCloudBankPayload(payload, relation.local_bank_id || createId("bank"), "saved-public");
      knownCloudIds.add(relation.bank_id);
      downloaded += 1;
    }
  }
  return downloaded;
}

async function saveCloudBankPayload(payload, localBankId, visibility) {
  const now = new Date().toISOString();
  const { localBank, localQuestions } = mapCloudBankToLocal({
    payload,
    localBankId,
    now,
    createQuestionId: () => createId("q"),
    buildBankName,
    countQuestionTypes,
    visibility,
  });
  await saveBankWithQuestions(localBank, localQuestions);
  const cloudRows = await cloud.getProgress(payload.bank.id);
  const mappedCloudRows = mapCloudProgressToLocal({
    cloudBankId: payload.bank.id,
    cloudRows: cloudRows || [],
    questions: localQuestions,
  });
  if (mappedCloudRows.length) await putMany(STORE_PROGRESS, mappedCloudRows);
}

async function syncOneBank(bank) {
  const result = { uploadedBank: false, savedBank: false, progressRows: 0 };
  let localBank = bank;
  let questions = (await getByIndex(STORE_QUESTIONS, "bankId", localBank.id)).sort((a, b) => a.order - b.order);

  if (localBank.visibility === "saved-public") {
    if (!localBank.cloudId) return result;
    await cloud.savePublicBank(localBank.cloudId, localBank.id);
    result.savedBank = true;
  } else if (questions.length) {
    if (!isProfileComplete(state.cloudProfile)) throw new Error("请先设置公开用户名和昵称");
    const visibility = localBank.visibility === "public" ? "public" : "private";
    const cloudId = await cloud.publishBank(localBank, questions, state.cloudProfile, visibility);
    questions = questions.map((question) => ({
      ...question,
      cloudQuestionId: `${cloudId}_${question.order}`,
    }));
    await putMany(STORE_QUESTIONS, questions);
    localBank = {
      ...localBank,
      cloudId,
      visibility,
      ownerUsername: state.cloudProfile.username,
      updatedAt: new Date().toISOString(),
    };
    await putRecord(STORE_BANKS, localBank);
    result.uploadedBank = true;
  }

  if (!localBank.cloudId) return result;
  const localRows = await getByIndex(STORE_PROGRESS, "bankId", localBank.id);
  const cloudRows = await cloud.getProgress(localBank.cloudId);
  const mappedCloudRows = mapCloudProgressToLocal({
    cloudBankId: localBank.cloudId,
    cloudRows: cloudRows || [],
    questions,
  });
  const mergedRows = mergeProgressRows({ localRows, cloudRows: mappedCloudRows });
  if (mergedRows.length) {
    await putMany(STORE_PROGRESS, mergedRows);
    const translated = mapLocalProgressToCloud({
      progressRows: mergedRows,
      questions,
      cloudBankId: localBank.cloudId,
    });
    await cloud.pushProgress(translated);
  }
  result.progressRows = mergedRows.length;
  return result;
}

function mapLocalProgressToCloud({ progressRows, questions, cloudBankId }) {
  const byLocalQuestionId = new Map(questions.map((question) => [question.id, question]));
  return progressRows.flatMap((item) => {
    const question = byLocalQuestionId.get(item.questionId);
    const cloudQuestionId = question?.cloudQuestionId || (question ? `${cloudBankId}_${question.order}` : "");
    if (!cloudQuestionId) return [];
    return [{
      ...item,
      bankId: cloudBankId,
      questionId: cloudQuestionId,
    }];
  });
}

function normalizeRows(rows) {
  const questions = [];
  for (const row of rows) {
    const stem = cleanText(row[0]);
    const answer = normalizeAnswerText(row[1]);
    const analysis = cleanText(row[2]);
    if (!stem || !answer) continue;
    if (/说明|第一列放题干|导入模板/.test(stem)) continue;
    if (/题干/.test(stem) && /答案/.test(answer)) continue;

    const optionCells = row.slice(3, 10).map(cleanText);
    const type = detectQuestionType(stem, answer, optionCells);
    const options = buildOptions(type, optionCells);
    questions.push({ stem, answer: normalizeStoredAnswer(answer, type), analysis, type, options });
  }
  return questions;
}

function detectQuestionType(stem, answer, optionCells) {
  const compact = answer.toUpperCase().replace(/\s+/g, "");
  if (isJudgementAnswer(compact)) return "judge";
  if (/^[A-G]+$/.test(compact) && optionCells.some(Boolean)) {
    return compact.length > 1 ? "multiple" : "single";
  }
  if (/\{[^}]+\}/.test(stem) || !optionCells.some(Boolean)) return "fill";
  return "single";
}

function buildOptions(type, optionCells) {
  if (type === "judge") {
    return [
      { label: "正确", text: "正确", value: "正确" },
      { label: "错误", text: "错误", value: "错误" },
    ];
  }
  const labels = ["A", "B", "C", "D", "E", "F", "G"];
  return optionCells
    .map((text, index) => text ? { label: labels[index], text, value: labels[index] } : null)
    .filter(Boolean);
}

function normalizeStoredAnswer(answer, type) {
  if (type === "judge") return normalizeJudgement(answer);
  if (type === "single" || type === "multiple") return sortLetters(answer);
  return answer;
}

function startPractice() {
  state.queue = buildQueue(state.practiceMode);
  state.queueIndex = 0;
  state.selected = new Set();
  state.submitted = false;
  state.lastResult = null;
  state.examRunResults = new Map();
  state.lastExamRecord = null;
  state.examReviewIndex = 0;
  state.questionPickerOpen = false;
  if (!state.queue.length) {
    showToast("当前模式暂无题目");
  } else {
    persistPracticeSession();
  }
  render();
}

function resumePractice() {
  const session = getValidPracticeSession();
  if (!session) {
    showToast("没有可继续的练习");
    return;
  }
  const byId = new Map(state.questions.map((question) => [question.id, question]));
  state.practiceMode = session.mode;
  state.sessionMode = normalizeSessionMode(session.sessionMode);
  state.answerFeedbackMode = normalizeAnswerFeedbackMode(session.answerFeedbackMode || state.answerFeedbackMode);
  state.queue = dedupeQuestionsForPractice(session.queueIds.map((id) => byId.get(id)).filter(Boolean));
  state.queueIndex = Math.min(session.queueIndex, Math.max(state.queue.length - 1, 0));
  state.selected = new Set(session.selected || []);
  state.submitted = Boolean(session.submitted);
  state.lastResult = session.lastResult || null;
  state.examRunResults = new Map(Array.isArray(session.examRunResults) ? session.examRunResults : []);
  if (state.sessionMode === "exam") {
    restoreSelectionForCurrentQuestion();
  }
  state.questionPickerOpen = false;
  persistPracticeSession();
  render();
}

function buildQueue(mode) {
  let items = dedupeQuestionsForPractice([...state.questions]).sort((a, b) => a.order - b.order);
  if (mode === "wrong") items = items.filter((question) => getProgress(question.id).wrongCount > 0);
  if (mode === "favorite") items = items.filter((question) => getProgress(question.id).favorite);
  if (mode === "unanswered") items = items.filter((question) => !getProgress(question.id).answered);
  if (mode === "random") items = shuffle(items);
  return items;
}

function resetPracticeQueue() {
  state.queue = [];
  state.queueIndex = 0;
  state.selected = new Set();
  state.submitted = false;
  state.lastResult = null;
  state.examRunResults = new Map();
  state.lastExamRecord = null;
  state.examReviewIndex = 0;
  state.questionPickerOpen = false;
}

function hasActivePractice() {
  return Boolean(
    state.queue.length
    && (
      state.selected.size
      || state.submitted
      || state.lastResult
      || state.examRunResults.size
    )
  );
}

async function chooseOption(value) {
  if (state.submitted) return;
  const question = state.queue[state.queueIndex];
  if (!question) return;
  if (question.type === "multiple") {
    if (state.selected.has(value)) state.selected.delete(value);
    else state.selected.add(value);
  } else {
    state.selected = new Set([value]);
  }
  persistPracticeSession();
  if (state.sessionMode === "exam") {
    saveExamSelection();
    persistPracticeSession();
    render();
    return;
  }
  if (state.answerFeedbackMode === "instant" && question.type !== "multiple") {
    await submitAnswer();
    return;
  }
  render();
}

async function submitAnswer() {
  const question = state.queue[state.queueIndex];
  if (!question) return;
  if (state.sessionMode === "exam") {
    saveExamSelection();
    showToast("已记录本题答案");
    persistPracticeSession();
    render();
    return;
  }
  const result = evaluateCurrentQuestion(question);
  if (!result) return;
  await commitPracticeAnswer(question, result);
  render();
}

function evaluateCurrentQuestion(question) {
  if (question.type === "fill") {
    const fillValue = cleanText(document.querySelector("#fillAnswer")?.value || "");
    state.selected = fillValue ? new Set([fillValue]) : new Set();
  }
  if (!state.selected.size) {
    showToast("先选一个答案");
    return null;
  }

  const selectedAnswer = buildSelectedAnswer(question);
  const correct = isAnswerCorrect(question, selectedAnswer);
  return { correct, selectedAnswer };
}

async function commitPracticeAnswer(question, result) {
  const previous = getProgress(question.id);
  const next = {
    ...previous,
    id: question.id,
    bankId: question.bankId,
    questionId: question.id,
    selectedAnswer: result.selectedAnswer,
    answered: true,
    correct: result.correct,
    attempts: previous.attempts + 1,
    wrongCount: result.correct ? (previous.wrongCount || 0) : (previous.wrongCount || 0) + 1,
    mastered: result.correct ? previous.mastered : false,
    lastAnsweredAt: new Date().toISOString(),
  };
  state.progress.set(question.id, next);
  state.lastResult = result;
  state.submitted = true;
  await putRecord(STORE_PROGRESS, next);
  await updateBankLastStudied(question.bankId);
  await refreshBanks();
  persistPracticeSession();
  if (!result.correct) vibrateWrongFeedback();
}

function nextQuestion() {
  saveExamSelection();
  if (state.queueIndex + 1 >= state.queue.length) {
    clearPracticeSession(state.currentBankId);
    resetPracticeQueue();
    showToast("这一组完成了");
    render();
    return;
  }
  state.queueIndex += 1;
  restoreSelectionForCurrentQuestion();
  state.questionPickerOpen = false;
  persistPracticeSession();
  render();
}

function persistPracticeSession() {
  if (!state.currentBankId || !state.queue.length) return;
  const payload = {
    bankId: state.currentBankId,
    mode: state.practiceMode,
    sessionMode: state.sessionMode,
    answerFeedbackMode: state.answerFeedbackMode,
    queueIds: state.queue.map((question) => question.id),
    queueIndex: state.queueIndex,
    selected: [...state.selected],
    submitted: state.submitted,
    lastResult: state.lastResult,
    examRunResults: [...state.examRunResults.entries()],
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(PRACTICE_SESSION_KEY, JSON.stringify(payload));
}

function readPracticeSession() {
  try {
    return JSON.parse(localStorage.getItem(PRACTICE_SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function getValidPracticeSession() {
  const session = readPracticeSession();
  if (!session || session.bankId !== state.currentBankId || !Array.isArray(session.queueIds)) return null;
  const knownIds = new Set(state.questions.map((question) => question.id));
  const byId = new Map(state.questions.map((question) => [question.id, question]));
  const queueIds = dedupeQuestionsForPractice(session.queueIds.map((id) => byId.get(id)).filter(Boolean))
    .map((question) => question.id)
    .filter((id) => knownIds.has(id));
  if (!queueIds.length) return null;
  return {
    ...session,
    mode: session.mode || "sequential",
    sessionMode: normalizeSessionMode(session.sessionMode || session.answerFeedbackMode),
    answerFeedbackMode: normalizeAnswerFeedbackMode(session.answerFeedbackMode),
    queueIds,
    queueIndex: Math.min(Math.max(Number(session.queueIndex) || 0, 0), queueIds.length - 1),
    selected: Array.isArray(session.selected) ? session.selected : [],
  };
}

function clearPracticeSession(bankId = "") {
  const session = readPracticeSession();
  if (!bankId || !session || session.bankId === bankId) {
    localStorage.removeItem(PRACTICE_SESSION_KEY);
  }
}

function saveExamSelection() {
  if (state.sessionMode !== "exam") return;
  const question = state.queue[state.queueIndex];
  if (!question) return;
  if (question.type === "fill") {
    const fillValue = cleanText(document.querySelector("#fillAnswer")?.value || "");
    state.selected = fillValue ? new Set([fillValue]) : new Set();
  }
  if (!state.selected.size) {
    state.examRunResults.delete(question.id);
    return;
  }
  state.examRunResults.set(question.id, { selectedAnswer: buildSelectedAnswer(question), answered: true });
}

function restoreSelectionForCurrentQuestion() {
  const question = state.queue[state.queueIndex];
  const result = question ? state.examRunResults.get(question.id) : null;
  state.selected = result ? selectedAnswerToSet(question, result.selectedAnswer) : new Set();
  state.submitted = false;
  state.lastResult = null;
}

function selectedAnswerToSet(question, selectedAnswer) {
  if (!selectedAnswer) return new Set();
  if (question?.type === "multiple") return new Set(String(selectedAnswer).split(""));
  return new Set([selectedAnswer]);
}

async function finishExam() {
  saveExamSelection();
  const bank = getCurrentBank();
  if (!bank) return;
  const now = new Date().toISOString();
  const results = state.queue.map((item) => {
    const saved = state.examRunResults.get(item.id);
    const selectedAnswer = saved?.selectedAnswer || "";
    const answered = Boolean(selectedAnswer);
    return {
      questionId: item.id,
      order: item.order,
      type: item.type,
      stem: item.stem,
      selectedAnswer,
      answered,
      correct: answered && isAnswerCorrect(item, selectedAnswer),
    };
  });
  const correctCount = results.filter((item) => item.correct).length;
  const unansweredCount = results.filter((item) => !item.answered).length;
  const wrongCount = results.filter((item) => item.answered && !item.correct).length;
  const record = {
    id: createId("exam"),
    bankId: state.currentBankId,
    bankTitle: getBankTitle(bank),
    total: results.length,
    correct: correctCount,
    wrong: wrongCount,
    unanswered: unansweredCount,
    accuracy: results.length ? Math.round((correctCount / results.length) * 100) : 0,
    results,
    createdAt: now,
  };
  await putRecord(STORE_EXAM_SESSIONS, record);
  state.lastExamRecord = record;
  state.examReviewIndex = 0;
  await refreshExamSessions();
  clearPracticeSession(state.currentBankId);
  state.queue = [];
  state.queueIndex = 0;
  state.selected = new Set();
  state.submitted = false;
  state.lastResult = null;
  showToast("考试已提交");
  render();
}

function renderExamSummary(record) {
  const results = record.results || [];
  const selectedIndex = getExamReviewIndex(record);
  const selectedItem = results[selectedIndex] || results[0] || null;
  return `
    <section class="panel">
      <div class="bank-head">
        <div>
          <h2>考试结算</h2>
          <p class="subtle">${escapeHtml(record.bankTitle)} · ${formatDateTime(record.createdAt)}</p>
        </div>
        <span class="type-pill ${record.accuracy >= 80 ? "good" : "warn"}">${record.accuracy}%</span>
      </div>
      <div class="metric-row">
        <div class="metric"><strong>${record.total}</strong><span>总题数</span></div>
        <div class="metric"><strong>${record.correct}</strong><span>正确</span></div>
        <div class="metric"><strong>${record.wrong}</strong><span>错误</span></div>
        <div class="metric"><strong>${record.unanswered || 0}</strong><span>未答</span></div>
      </div>
      <div class="actions" style="margin-top:12px;">
        <button class="button" type="button" data-action="add-exam-wrongs" data-id="${record.id}" ${record.wrong ? "" : "disabled"}>本次错题加入错题本</button>
        <button class="ghost-button" type="button" data-action="view-stats" data-id="${record.bankId}">查看考试记录</button>
        <button class="ghost-button" type="button" data-action="start-practice">再考一次</button>
      </div>
    </section>
    <section class="panel exam-review-panel">
      <div class="bank-head">
        <div>
          <h2>答题回顾</h2>
          <p class="subtle">绿色为正确，红色为错误，白色为未答。点击题号查看题目。</p>
        </div>
      </div>
      <div class="exam-number-grid">
        ${results.map((item, index) => renderExamReviewButton(item, index, selectedIndex)).join("")}
      </div>
      ${selectedItem ? renderExamResultItem(selectedItem, selectedIndex) : renderEmpty("暂无题目", "这次考试没有记录题目。")}
    </section>
  `;
}

function renderExamReviewButton(item, index, selectedIndex) {
  const answered = isExamResultAnswered(item);
  const className = [
    "exam-number-button",
    index === selectedIndex ? "is-current" : "",
    !answered ? "is-unanswered" : item.correct ? "is-correct" : "is-wrong",
  ].filter(Boolean).join(" ");
  return `
    <button class="${className}" type="button" data-action="review-exam-question" data-index="${index}" aria-label="查看第 ${item.order || index + 1} 题">
      ${item.order || index + 1}
    </button>
  `;
}

function renderExamResultItem(item, index = 0) {
  const answered = isExamResultAnswered(item);
  return `
    <article class="list-item exam-review-detail">
      <div class="chip-row">
        <span class="type-pill">第 ${item.order || index + 1} 题</span>
        <span class="type-pill">${typeLabel(item.type)}</span>
        <span class="type-pill ${!answered ? "" : item.correct ? "good" : "warn"}">${!answered ? "未答" : item.correct ? "正确" : "错误"}</span>
      </div>
      <p>${escapeHtml(item.stem)}</p>
      <p class="subtle">你的答案：${escapeHtml(item.selectedAnswer || "未作答")}</p>
    </article>
  `;
}

function getExamReviewIndex(record) {
  const total = record.results?.length || 0;
  if (!total) return 0;
  return Math.min(Math.max(Number(state.examReviewIndex) || 0, 0), total - 1);
}

function reviewExamQuestion(index) {
  const record = state.lastExamRecord;
  const total = record?.results?.length || 0;
  if (!Number.isInteger(index) || index < 0 || index >= total) return;
  state.examReviewIndex = index;
  render();
}

function isExamResultAnswered(item) {
  return item.answered ?? Boolean(item.selectedAnswer);
}

async function addExamWrongQuestions(recordId) {
  const record = state.examSessions.find((item) => item.id === recordId) || state.lastExamRecord;
  if (!record) return;
  const wrongIds = new Set(record.results.filter((item) => isExamResultAnswered(item) && !item.correct).map((item) => item.questionId));
  const now = new Date().toISOString();
  const rows = state.questions
    .filter((question) => wrongIds.has(question.id))
    .map((question) => {
      const current = getProgress(question.id);
      return {
        ...current,
        id: question.id,
        questionId: question.id,
        bankId: question.bankId,
        wrongCount: Math.max(1, current.wrongCount || 0),
        mastered: false,
        lastAnsweredAt: current.lastAnsweredAt || now,
      };
    });
  if (!rows.length) {
    showToast("没有可加入的错题");
    return;
  }
  await putMany(STORE_PROGRESS, rows);
  rows.forEach((row) => state.progress.set(row.questionId, row));
  await refreshBanks();
  showToast(`已加入 ${rows.length} 道错题`);
  render();
}

function buildSelectedAnswer(question) {
  const values = [...state.selected];
  if (question.type === "judge") return normalizeJudgement(values[0]);
  if (question.type === "multiple") return sortLetters(values.join(""));
  if (question.type === "fill") return values[0] || "";
  return values[0] || "";
}

function isAnswerCorrect(question, selectedAnswer) {
  if (question.type === "judge") return normalizeJudgement(selectedAnswer) === normalizeJudgement(question.answer);
  if (question.type === "multiple") return sortLetters(selectedAnswer) === sortLetters(question.answer);
  if (question.type === "single") return selectedAnswer === question.answer;
  return cleanText(selectedAnswer) === cleanText(question.answer);
}

function isOptionCorrect(question, option) {
  if (question.type === "judge") return normalizeJudgement(option.value) === normalizeJudgement(question.answer);
  return question.answer.includes(option.label);
}

async function toggleFavorite(questionId) {
  const current = getProgress(questionId);
  const question = state.questions.find((item) => item.id === questionId);
  const next = {
    ...current,
    id: questionId,
    questionId,
    bankId: question?.bankId || state.currentBankId,
    favorite: !current.favorite,
  };
  state.progress.set(questionId, next);
  await putRecord(STORE_PROGRESS, next);
  render();
}

async function addToWrongBook(questionId) {
  const current = getProgress(questionId);
  const question = state.questions.find((item) => item.id === questionId);
  const next = {
    ...current,
    id: questionId,
    questionId,
    bankId: question?.bankId || state.currentBankId,
    wrongCount: Math.max(1, current.wrongCount || 0),
    mastered: false,
  };
  state.progress.set(questionId, next);
  await putRecord(STORE_PROGRESS, next);
  await refreshBanks();
  showToast("已加入错题本");
  render();
}

async function markMastered(questionId) {
  const current = await getProgressRecord(questionId);
  const question = state.questions.find((item) => item.id === questionId)
    || state.reviewGroups.flatMap((group) => [...group.wrongQuestions, ...group.favoriteQuestions]).find((item) => item.question.id === questionId)?.question;
  const next = {
    ...current,
    id: questionId,
    questionId,
    bankId: current.bankId || question?.bankId || state.currentBankId,
    wrongCount: 0,
    mastered: true,
  };
  if (next.bankId === state.currentBankId) state.progress.set(questionId, next);
  await putRecord(STORE_PROGRESS, next);
  await refreshBanks();
  if (state.view === "wrong") await loadReviewGroups();
  showToast("已移出错题本");
  render();
}

async function selectBank(id, nextView) {
  state.editingBankId = "";
  state.questionPickerOpen = false;
  setCurrentBank(id, true);
  await loadCurrentBank();
  resetPracticeQueue();
  state.view = nextView;
  render();
}

function setCurrentBank(id, persist) {
  state.currentBankId = id;
  if (persist) localStorage.setItem(CURRENT_BANK_KEY, id);
}

function setSessionMode(mode) {
  const nextMode = normalizeSessionMode(mode);
  if (nextMode === state.sessionMode) return;
  if (hasActivePractice() && !confirm("切换本次模式会清空当前进行中的答题，确定继续吗？")) {
    render();
    return;
  }
  state.sessionMode = nextMode;
  localStorage.setItem(SESSION_MODE_KEY, state.sessionMode);
  resetPracticeQueue();
  render();
}

function setAnswerFeedbackMode(mode) {
  const nextMode = normalizeAnswerFeedbackMode(mode);
  if (nextMode === state.answerFeedbackMode) return;
  if (hasActivePractice() && state.sessionMode === "practice" && !confirm("切换练习反馈会清空当前进行中的答题，确定继续吗？")) {
    render();
    return;
  }
  state.answerFeedbackMode = nextMode;
  localStorage.setItem(ANSWER_FEEDBACK_KEY, state.answerFeedbackMode);
  resetPracticeQueue();
  render();
}

function toggleQuestionPicker() {
  if (!state.queue.length) return;
  state.questionPickerOpen = !state.questionPickerOpen;
  render();
}

function closeQuestionPicker() {
  if (!state.questionPickerOpen) return;
  state.questionPickerOpen = false;
  render();
}

function jumpToQuestion(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.queue.length) return;
  saveExamSelection();
  state.queueIndex = index;
  restoreSelectionForCurrentQuestion();
  state.questionPickerOpen = false;
  persistPracticeSession();
  render();
}

async function editBank(id) {
  openBankEditor(id);
}

function openBankEditor(id) {
  const bank = state.banks.find((item) => item.id === id);
  if (!bank) return;
  state.editingBankId = id;
  render();
}

function closeBankEditor() {
  if (!state.editingBankId) return;
  state.editingBankId = "";
  render();
}

async function saveBankEdit(formData) {
  const id = cleanText(formData.get("id"));
  const bank = state.banks.find((item) => item.id === id);
  if (!bank) return;
  if (bank.cloudId) {
    const addTags = splitTags(formData.get("addTags"));
    if (!addTags.length) {
      showToast("请输入要添加的标签");
      return;
    }
    const tags = [...new Set([...(bank.tags || []), ...addTags].map(cleanText).filter(Boolean))];
    const updated = {
      ...bank,
      tags,
      updatedAt: new Date().toISOString(),
    };
    await putRecord(STORE_BANKS, updated);
    state.editingBankId = "";
    await refreshBanks();
    showToast(`已添加 ${tags.length - (bank.tags || []).length} 个本地标签`);
    render();
    return;
  }
  const course = cleanText(formData.get("course"));
  const chapter = cleanText(formData.get("chapter"));
  const tags = splitTags(formData.get("tags"));
  if (!course) {
    showToast("课程不能为空");
    return;
  }
  const updated = {
    ...bank,
    name: buildBankName(course, chapter, bank.name),
    course,
    chapter,
    tags,
    updatedAt: new Date().toISOString(),
  };
  await putRecord(STORE_BANKS, updated);
  state.editingBankId = "";
  await refreshBanks();
  render();
}

async function deleteBank(id) {
  const bank = state.banks.find((item) => item.id === id);
  if (!bank) return;
  if (!confirm(`确定删除“${getBankTitle(bank)}”吗？相关练习记录也会删除。`)) return;
  await deleteBankCascade(id);
  clearPracticeSession(id);
  if (state.currentBankId === id) {
    state.currentBankId = "";
    localStorage.removeItem(CURRENT_BANK_KEY);
    state.questions = [];
    state.progress = new Map();
  }
  if (state.editingBankId === id) {
    state.editingBankId = "";
  }
  await refreshBanks();
  await refreshExamSessions();
  if (!state.currentBankId && state.banks[0]) {
    setCurrentBank(state.banks[0].id, true);
    await loadCurrentBank();
  }
  render();
}

async function deleteSelectedBanks() {
  const ids = [...state.selectedBankIds].filter((id) => state.banks.some((bank) => bank.id === id));
  if (!ids.length) {
    showToast("请先选择题库");
    return;
  }
  if (!confirm(`确定删除选中的 ${ids.length} 个题库吗？相关题目、练习记录和考试记录也会删除。`)) return;
  for (const id of ids) {
    await deleteBankCascade(id);
    clearPracticeSession(id);
  }
  state.selectedBankIds.clear();
  state.bankBulkMode = false;
  if (ids.includes(state.currentBankId)) {
    state.currentBankId = "";
    localStorage.removeItem(CURRENT_BANK_KEY);
    state.questions = [];
    state.progress = new Map();
    resetPracticeQueue();
  }
  if (ids.includes(state.editingBankId)) {
    state.editingBankId = "";
  }
  await refreshBanks();
  await refreshExamSessions();
  if (!state.currentBankId && state.banks[0]) {
    setCurrentBank(state.banks[0].id, true);
    await loadCurrentBank();
  } else if (state.currentBankId) {
    await loadCurrentBank();
  }
  showToast(`已删除 ${ids.length} 个题库`);
  render();
}

async function exportBackup() {
  const backup = {
    version: 2,
    exportedAt: new Date().toISOString(),
    banks: await getAll(STORE_BANKS),
    questions: await getAll(STORE_QUESTIONS),
    progress: await getAll(STORE_PROGRESS),
    examSessions: await getAll(STORE_EXAM_SESSIONS),
  };
  downloadBlob(`我爱刷题备份-${dateStamp()}.json`, new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" }));
  showToast("备份已导出");
}

function exportReviewBank(bankId) {
  const group = state.reviewGroups.find((item) => item.bank.id === bankId);
  if (!group) {
    showToast("没有可导出的错题或收藏");
    return;
  }
  const payload = buildReviewExport({
    bank: group.bank,
    wrongQuestions: group.wrongQuestions,
    favoriteQuestions: group.favoriteQuestions,
    exportedAt: new Date().toISOString(),
  });
  const filename = `${getBankTitle(group.bank)}-错题收藏-${dateStamp()}.json`;
  downloadBlob(filename, new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }));
  showToast("错题与收藏已导出");
}

function toggleReviewBank(bankId) {
  if (!bankId) return;
  if (state.expandedReviewBankIds.has(bankId)) state.expandedReviewBankIds.delete(bankId);
  else state.expandedReviewBankIds.add(bankId);
  render();
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const backup = JSON.parse(text);
    if (!Array.isArray(backup.banks) || !Array.isArray(backup.questions)) {
      throw new Error("备份格式不正确");
    }
    if (!confirm("导入备份会新增为本地题库，不会删除现有题库。若出现重复题库，可以导入后自行删除或保留。确定继续吗？")) return;
    const imported = remapBackupForAppend(backup);
    if (!imported.banks.length) throw new Error("备份里没有可导入的题库");
    await putMany(STORE_BANKS, imported.banks);
    await putMany(STORE_QUESTIONS, imported.questions);
    if (imported.progress.length) await putMany(STORE_PROGRESS, imported.progress);
    if (imported.examSessions.length) await putMany(STORE_EXAM_SESSIONS, imported.examSessions);
    await refreshBanks();
    await refreshExamSessions();
    state.currentBankId = imported.banks[0]?.id || state.banks[0]?.id || "";
    if (state.currentBankId) localStorage.setItem(CURRENT_BANK_KEY, state.currentBankId);
    await loadCurrentBank();
    showToast(`已导入 ${imported.banks.length} 个题库`);
    state.view = "banks";
    render();
  } catch (error) {
    console.error(error);
    showToast(`恢复失败：${error.message || error}`);
  }
}

function remapBackupForAppend(backup) {
  const now = new Date().toISOString();
  const bankIdMap = new Map();
  const questionIdMap = new Map();
  const questionBankMap = new Map();

  const banks = backup.banks
    .filter((bank) => bank && bank.id)
    .map((bank) => {
      const nextId = createId("bank");
      bankIdMap.set(bank.id, nextId);
      const { cloudId, visibility, ownerUsername, ...localBank } = bank;
      return {
        ...localBank,
        id: nextId,
        createdAt: localBank.createdAt || now,
        updatedAt: now,
      };
    });

  const questions = backup.questions
    .filter((question) => question && question.id && bankIdMap.has(question.bankId))
    .map((question) => {
      const nextId = createId("q");
      const nextBankId = bankIdMap.get(question.bankId);
      questionIdMap.set(question.id, nextId);
      questionBankMap.set(question.id, nextBankId);
      const { cloudQuestionId, ...localQuestion } = question;
      return {
        ...localQuestion,
        id: nextId,
        bankId: nextBankId,
        createdAt: localQuestion.createdAt || now,
      };
    });

  const progress = (backup.progress || [])
    .filter((item) => item && questionIdMap.has(item.questionId))
    .map((item) => {
      const nextQuestionId = questionIdMap.get(item.questionId);
      return {
        ...item,
        id: nextQuestionId,
        bankId: questionBankMap.get(item.questionId),
        questionId: nextQuestionId,
      };
    });

  const examSessions = (backup.examSessions || [])
    .filter((item) => item && item.id && bankIdMap.has(item.bankId))
    .map((item) => ({
      ...item,
      id: createId("exam"),
      bankId: bankIdMap.get(item.bankId),
      results: (item.results || []).map((result) => ({
        ...result,
        questionId: questionIdMap.get(result.questionId) || result.questionId,
      })),
    }));

  return { banks, questions, progress, examSessions };
}

async function clearAllData() {
  if (!confirm("确定清空所有题库和练习记录吗？")) return;
  await clearStores();
  state.banks = [];
  state.allProgress = [];
  state.examSessions = [];
  state.questions = [];
  state.progress = new Map();
  state.currentBankId = "";
  localStorage.removeItem(CURRENT_BANK_KEY);
  clearPracticeSession();
  resetPracticeQueue();
  showToast("已清空");
  render();
}

async function readXlsxRows(file) {
  const buffer = await file.arrayBuffer();
  const entries = await unzip(buffer);
  const workbookXml = getTextEntry(entries, "xl/workbook.xml");
  const relsXml = getTextEntry(entries, "xl/_rels/workbook.xml.rels");
  const parser = new DOMParser();
  const workbook = parser.parseFromString(workbookXml, "application/xml");
  const rels = parser.parseFromString(relsXml, "application/xml");
  const sheets = getXmlElements(workbook, "sheet");
  const relMap = new Map(getXmlElements(rels, "Relationship").map((rel) => [rel.getAttribute("Id"), rel.getAttribute("Target")]));
  const selectedSheet = sheets.find((sheet) => /任选|导入|题/.test(sheet.getAttribute("name") || "")) || sheets[0];
  if (!selectedSheet) throw new Error("Excel 中没有工作表");
  const relId = selectedSheet.getAttribute("r:id") || selectedSheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
  const target = relMap.get(relId);
  if (!target) throw new Error("无法定位工作表内容");
  const sheetPath = normalizeXlsxPath(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  const sheetXml = getTextEntry(entries, sheetPath);
  const sharedStrings = parseSharedStrings(entries);
  return parseSheetRows(sheetXml, sharedStrings);
}

function parseSharedStrings(entries) {
  if (!entries.has("xl/sharedStrings.xml")) return [];
  const xml = getTextEntry(entries, "xl/sharedStrings.xml");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return getXmlElements(doc, "si").map((item) => {
    return getXmlElements(item, "t").map((text) => text.textContent || "").join("");
  });
}

function parseSheetRows(sheetXml, sharedStrings) {
  const doc = new DOMParser().parseFromString(sheetXml, "application/xml");
  return getXmlElements(doc, "row").map((row) => {
    const values = [];
    getXmlElements(row, "c").forEach((cell, fallbackIndex) => {
      const ref = cell.getAttribute("r");
      const index = ref ? columnIndex(ref) : fallbackIndex;
      values[index] = parseCell(cell, sharedStrings);
    });
    return values.map((value) => value || "");
  });
}

function parseCell(cell, sharedStrings) {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") {
    return getXmlElements(cell, "t").map((item) => item.textContent || "").join("");
  }
  const value = getXmlElements(cell, "v")[0]?.textContent || "";
  if (type === "s") return sharedStrings[Number(value)] || "";
  return value;
}

function getXmlElements(parent, localName) {
  return [...parent.getElementsByTagName("*")].filter((element) => element.localName === localName || element.nodeName.split(":").pop() === localName);
}

async function unzip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) throw new Error("不是有效的 xlsx 文件");
  const entriesCount = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const entries = new Map();
  let ptr = centralOffset;
  const decoder = new TextDecoder();

  for (let i = 0; i < entriesCount; i += 1) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error("xlsx 压缩目录损坏");
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const nameLength = view.getUint16(ptr + 28, true);
    const extraLength = view.getUint16(ptr + 30, true);
    const commentLength = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.slice(ptr + 46, ptr + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : await inflateRaw(compressed, method);
    entries.set(normalizeXlsxPath(name), data);
    ptr += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflateRaw(data, method) {
  if (method !== 8) throw new Error(`不支持的 Excel 压缩方式：${method}`);
  if (!("DecompressionStream" in window)) {
    throw new Error("当前浏览器不支持解压标准 xlsx，请使用新版 Safari/Chrome，或先用本应用导出的备份恢复。");
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEndOfCentralDirectory(view) {
  const min = Math.max(0, view.byteLength - 66000);
  for (let offset = view.byteLength - 22; offset >= min; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

function getTextEntry(entries, path) {
  const key = normalizeXlsxPath(path);
  const data = entries.get(key);
  if (!data) throw new Error(`Excel 缺少 ${key}`);
  return new TextDecoder().decode(data);
}

function normalizeXlsxPath(path) {
  const parts = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function columnIndex(ref) {
  const letters = ref.match(/[A-Z]+/i)?.[0] || "A";
  let value = 0;
  for (const letter of letters.toUpperCase()) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}

async function refreshBanks() {
  state.banks = (await getAll(STORE_BANKS)).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  state.allQuestions = await getAll(STORE_QUESTIONS);
  state.allProgress = await getAll(STORE_PROGRESS);
}

async function refreshExamSessions() {
  state.examSessions = (await getAll(STORE_EXAM_SESSIONS)).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

async function loadReviewGroups() {
  state.reviewLoading = true;
  const [banks, questions, progressRows] = await Promise.all([
    getAll(STORE_BANKS),
    getAll(STORE_QUESTIONS),
    getAll(STORE_PROGRESS),
  ]);
  state.reviewGroups = buildReviewGroups({ banks, questions, progressRows });
  state.reviewLoading = false;
  state.reviewLoaded = true;
}

async function loadCurrentBank() {
  if (!state.currentBankId) return;
  state.questions = (await getByIndex(STORE_QUESTIONS, "bankId", state.currentBankId)).sort((a, b) => a.order - b.order);
  const progressRows = await getByIndex(STORE_PROGRESS, "bankId", state.currentBankId);
  state.progress = new Map(progressRows.map((item) => [item.questionId, item]));
}

async function saveBankWithQuestions(bank, questions) {
  const db = await openDB();
  await txDone(db, [STORE_BANKS, STORE_QUESTIONS], "readwrite", (tx) => {
    tx.objectStore(STORE_BANKS).put(bank);
    const questionStore = tx.objectStore(STORE_QUESTIONS);
    questions.forEach((question) => questionStore.put(question));
  });
}

async function replaceBankWithQuestions(bank, questions) {
  const db = await openDB();
  await txDone(db, [STORE_BANKS, STORE_QUESTIONS], "readwrite", (tx) => {
    tx.objectStore(STORE_BANKS).put(bank);
    const questionStore = tx.objectStore(STORE_QUESTIONS);
    const oldRequest = questionStore.index("bankId").openCursor(IDBKeyRange.only(bank.id));
    oldRequest.onsuccess = () => {
      const cursor = oldRequest.result;
      if (!cursor) {
        questions.forEach((question) => questionStore.put(question));
        return;
      }
      cursor.delete();
      cursor.continue();
    };
  });
}

async function deleteBankCascade(bankId) {
  const questions = await getByIndex(STORE_QUESTIONS, "bankId", bankId);
  const progress = await getByIndex(STORE_PROGRESS, "bankId", bankId);
  const examSessions = await getByIndex(STORE_EXAM_SESSIONS, "bankId", bankId);
  const db = await openDB();
  await txDone(db, [STORE_BANKS, STORE_QUESTIONS, STORE_PROGRESS, STORE_EXAM_SESSIONS], "readwrite", (tx) => {
    tx.objectStore(STORE_BANKS).delete(bankId);
    questions.forEach((question) => tx.objectStore(STORE_QUESTIONS).delete(question.id));
    progress.forEach((item) => tx.objectStore(STORE_PROGRESS).delete(item.id));
    examSessions.forEach((item) => tx.objectStore(STORE_EXAM_SESSIONS).delete(item.id));
  });
}

async function updateBankLastStudied(bankId) {
  const bank = state.banks.find((item) => item.id === bankId);
  if (!bank) return;
  await putRecord(STORE_BANKS, { ...bank, lastStudiedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_BANKS)) db.createObjectStore(STORE_BANKS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_QUESTIONS)) {
        const store = db.createObjectStore(STORE_QUESTIONS, { keyPath: "id" });
        store.createIndex("bankId", "bankId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
        const store = db.createObjectStore(STORE_PROGRESS, { keyPath: "id" });
        store.createIndex("bankId", "bankId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_EXAM_SESSIONS)) {
        const store = db.createObjectStore(STORE_EXAM_SESSIONS, { keyPath: "id" });
        store.createIndex("bankId", "bankId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function getAll(storeName) {
  const db = await openDB();
  return requestPromise(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
}

async function getByIndex(storeName, indexName, value) {
  const db = await openDB();
  return requestPromise(db.transaction(storeName, "readonly").objectStore(storeName).index(indexName).getAll(value));
}

async function getRecord(storeName, key) {
  const db = await openDB();
  return requestPromise(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
}

async function getProgressRecord(questionId) {
  return await getRecord(STORE_PROGRESS, questionId) || {
    id: questionId,
    questionId,
    bankId: "",
    selectedAnswer: "",
    answered: false,
    correct: false,
    attempts: 0,
    wrongCount: 0,
    favorite: false,
    mastered: false,
    lastAnsweredAt: "",
  };
}

async function putRecord(storeName, record) {
  const db = await openDB();
  await requestPromise(db.transaction(storeName, "readwrite").objectStore(storeName).put(record));
}

async function putMany(storeName, records) {
  const db = await openDB();
  await txDone(db, storeName, "readwrite", (tx) => {
    const store = tx.objectStore(storeName);
    records.forEach((record) => store.put(record));
  });
}

async function clearStores() {
  const db = await openDB();
  await txDone(db, [STORE_BANKS, STORE_QUESTIONS, STORE_PROGRESS, STORE_EXAM_SESSIONS], "readwrite", (tx) => {
    tx.objectStore(STORE_BANKS).clear();
    tx.objectStore(STORE_QUESTIONS).clear();
    tx.objectStore(STORE_PROGRESS).clear();
    tx.objectStore(STORE_EXAM_SESSIONS).clear();
  });
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(db, stores, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    work(tx);
  });
}

function getCurrentBank() {
  return state.banks.find((bank) => bank.id === state.currentBankId);
}

function getProgress(questionId) {
  return state.progress.get(questionId) || {
    id: questionId,
    questionId,
    bankId: state.currentBankId,
    selectedAnswer: "",
    answered: false,
    correct: false,
    attempts: 0,
    wrongCount: 0,
    favorite: false,
    mastered: false,
    lastAnsweredAt: "",
  };
}

function getBankProgress(bankId) {
  const bank = state.banks.find((item) => item.id === bankId);
  return calculateBankProgress({
    bank,
    questions: state.allQuestions,
    progressRows: state.allProgress,
  });
}

function getCurrentSummary() {
  const rows = [...state.progress.values()];
  const done = rows.filter((item) => item.answered).length;
  const correct = rows.filter((item) => item.correct).length;
  const wrong = rows.filter((item) => item.wrongCount > 0).length;
  return { done, correct, wrong, accuracy: done ? Math.round((correct / done) * 100) : 0 };
}

function getCurrentExamRecords() {
  return state.examSessions.filter((item) => item.bankId === state.currentBankId);
}

function getOwnedPublishedBanks() {
  return state.banks.filter((bank) => isOwnedPublishedBank(bank));
}

function isOwnedPublishedBank(bank) {
  const username = cleanText(state.cloudProfile?.username);
  return Boolean(bank?.cloudId && username && getBankOwnerUsername(bank) === username);
}

function toggleSelection(set, id) {
  if (!id) return;
  if (set.has(id)) set.delete(id);
  else set.add(id);
}

function getBankOwnerUsername(bank) {
  return cleanText(bank?.ownerUsername || bank?.sourceOwnerUsername || bank?.owner_username);
}

function getFilteredBanks() {
  const keyword = state.bankFilter.toLowerCase();
  if (!keyword) return state.banks;
  return state.banks.filter((bank) => {
    const text = [getBankTitle(bank), bank.course, bank.chapter, ...(bank.tags || [])].join(" ").toLowerCase();
    return text.includes(keyword);
  });
}

function getBankTitle(bank) {
  return cleanText(bank?.course) || cleanText(bank?.name) || "未命名课程";
}

function buildBankName(course, chapter, fallback = "") {
  return [cleanText(course), cleanText(chapter)].filter(Boolean).join(" - ") || cleanText(String(fallback).replace(/\.[^.]+$/, "")) || "未命名题库";
}

function getAvatarText(value) {
  const text = cleanText(value);
  return text ? text.slice(0, 1).toUpperCase() : "我";
}

function vibrateWrongFeedback() {
  try {
    if ("vibrate" in navigator) navigator.vibrate([35, 25, 35]);
  } catch {
    // Some browsers, especially iOS Safari, do not support vibration.
  }
}

function countQuestionTypes(questions) {
  return questions.reduce((acc, question) => {
    acc[question.type] = (acc[question.type] || 0) + 1;
    return acc;
  }, {});
}

function getAnswerDisplay(question) {
  if (question.type === "judge" || question.type === "fill") return question.answer;
  const selected = question.options.filter((option) => question.answer.includes(option.label));
  return selected.map((option) => `${option.label}. ${option.text}`).join("；") || question.answer;
}

function typeLabel(type) {
  return ({ single: "单选", multiple: "多选", judge: "判断", fill: "填空" })[type] || "题目";
}

function queueModeName(mode) {
  return ({ sequential: "顺序", random: "随机", wrong: "错题", favorite: "收藏", unanswered: "未做" })[mode] || "练习";
}

function sessionModeName(mode) {
  return ({ practice: "练习模式", exam: "考试模式" })[mode] || "练习模式";
}

function answerFeedbackModeName(mode) {
  return ({ instant: "直接显示答案", submit: "提交后显示答案" })[mode] || "提交后显示答案";
}

function isJudgementAnswer(answer) {
  return /^(正确|错误|对|错|√|×|Y|N|YES|NO|TRUE|FALSE)$/i.test(answer);
}

function normalizeJudgement(answer) {
  const value = cleanText(answer).toUpperCase();
  if (/^(正确|对|√|Y|YES|TRUE)$/.test(value)) return "正确";
  if (/^(错误|错|×|X|N|NO|FALSE)$/.test(value)) return "错误";
  return cleanText(answer);
}

function normalizeAnswerText(answer) {
  return cleanText(answer).replace(/[，、,;；\s]+/g, "");
}

function sortLetters(value) {
  return [...new Set(String(value).toUpperCase().replace(/[^A-G]/g, "").split(""))].sort().join("");
}

function splitTags(value) {
  return cleanText(value).split(/[，,、\s]+/).map(cleanText).filter(Boolean);
}

function normalizeUsername(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function normalizeSessionMode(value) {
  if (value === "exam") return "exam";
  return SESSION_MODES.has(value) ? value : "practice";
}

function normalizeAnswerFeedbackMode(value) {
  if (value === "drill") return "instant";
  if (value === "thinking" || value === "exam") return "submit";
  return ANSWER_FEEDBACK_MODES.has(value) ? value : "submit";
}

function normalizeTheme(value) {
  return THEMES.has(value) ? value : "default";
}

function applyTheme(theme) {
  const nextTheme = normalizeTheme(theme);
  state.appTheme = nextTheme;
  if (nextTheme === "default") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = nextTheme;
  }
  localStorage.setItem(THEME_KEY, nextTheme);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function cleanText(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function renderEmpty(title, text) {
  return `<section class="empty-state"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></section>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("已复制");
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    showToast("已复制");
  }
}

async function checkAppVersion() {
  state.appVersion.checking = true;
  state.appVersion.error = "";
  rerenderAccountVersion();
  try {
    const response = await fetch(`./version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`version.json ${response.status}`);
    const manifest = await response.json();
    const latest = String(manifest.version || "").trim();
    if (!latest) throw new Error("version.json 缺少 version 字段");
    const current = localStorage.getItem(APP_VERSION_KEY) || "";
    if (!current) {
      localStorage.setItem(APP_VERSION_KEY, latest);
      state.appVersion.current = latest;
      state.appVersion.latest = latest;
      state.appVersion.updateAvailable = false;
    } else {
      state.appVersion.current = current;
      state.appVersion.latest = latest;
      state.appVersion.updateAvailable = current !== latest;
    }
  } catch (error) {
    console.warn("版本检查失败", error);
    state.appVersion.error = error.message || "无法读取版本信息";
  } finally {
    state.appVersion.checking = false;
    rerenderAccountVersion();
  }
}

function rerenderAccountVersion() {
  if (state.view === "account") render();
}

async function refreshAppAssets() {
  const latest = state.appVersion.latest;
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith(APP_CACHE_PREFIX)).map((key) => caches.delete(key)));
    }
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if (latest) localStorage.setItem(APP_VERSION_KEY, latest);
    showToast("正在更新应用");
    window.setTimeout(() => window.location.reload(), 300);
  } catch (error) {
    console.error("更新失败", error);
    showToast("更新失败，请稍后重试");
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    console.warn("Service worker registration failed", error);
  });
}
