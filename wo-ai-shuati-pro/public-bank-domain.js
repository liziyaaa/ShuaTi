export function isProfileComplete(profile) {
  return Boolean(String(profile?.username || "").trim() && String(profile?.display_name || "").trim());
}

export function compareChapterLabels(left, right) {
  const a = buildChapterSortKey(left);
  const b = buildChapterSortKey(right);
  if (a.category !== b.category) return a.category - b.category;
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < length; index += 1) {
    if (a.numbers[index] === undefined) return -1;
    if (b.numbers[index] === undefined) return 1;
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  return a.text.localeCompare(b.text, "zh-CN", { numeric: true, sensitivity: "base" });
}

function buildChapterSortKey(value) {
  const text = String(value || "").trim();
  if (!text) return { category: 4, numbers: [], text };
  if (/(?:导论|绪论|前言|引言|概论)/.test(text)) return { category: 0, numbers: [], text };

  const arabicNumbers = [...text.matchAll(/\d+(?:\.\d+)*/g)]
    .flatMap((match) => match[0].split(".").map(Number));
  if (arabicNumbers.length) return { category: 1, numbers: arabicNumbers, text };

  const chineseNumberPattern = /(?:第\s*)?([零〇一二两三四五六七八九十百千]+)\s*(?=章|节|单元|篇|部分)/g;
  const chineseNumbers = [...text.matchAll(chineseNumberPattern)].map((match) => parseChineseNumber(match[1]));
  if (chineseNumbers.length) return { category: 1, numbers: chineseNumbers, text };

  const chinesePrefix = text.match(/^([零〇一二两三四五六七八九十百千]+)(?:\s*[、.．]|$)/);
  if (chinesePrefix) return { category: 1, numbers: [parseChineseNumber(chinesePrefix[1])], text };
  return { category: 3, numbers: [], text };
}

function parseChineseNumber(value) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (Object.hasOwn(digits, character)) {
      current = digits[character];
    } else if (Object.hasOwn(units, character)) {
      total += (current || 1) * units[character];
      current = 0;
    }
  }
  return total + current;
}

export function getPublishBlocker({ cloudConfigured, cloudUser, cloudProfile }) {
  if (!cloudConfigured) return "请先配置 Supabase";
  if (!cloudUser) return "请先登录";
  if (!isProfileComplete(cloudProfile)) return "请先设置公开用户名和昵称";
  return "";
}

export function findSavedPublicBank(banks, cloudId) {
  return banks.find((bank) => bank.cloudId === cloudId) || null;
}

export function buildSavedBankRelation({ userId, cloudBankId, localBankId, now }) {
  return {
    id: `${userId}_${cloudBankId}`,
    user_id: userId,
    bank_id: cloudBankId,
    local_bank_id: localBankId,
    saved_at: now,
    updated_at: now,
  };
}

export function mapCloudProgressToLocal({ cloudBankId = "", cloudRows, questions }) {
  const byCloudQuestionId = new Map();
  questions.forEach((question) => {
    if (question.cloudQuestionId) byCloudQuestionId.set(question.cloudQuestionId, question);
    else if (cloudBankId && question.order) {
      const fallbackId = `${cloudBankId}_${question.order}`;
      if (!byCloudQuestionId.has(fallbackId)) byCloudQuestionId.set(fallbackId, question);
    }
  });
  return cloudRows.flatMap((row) => {
    const question = byCloudQuestionId.get(row.question_id);
    if (!question) return [];
    return [{
      id: question.id,
      questionId: question.id,
      bankId: question.bankId,
      selectedAnswer: row.selected_answer || "",
      answered: Boolean(row.answered),
      correct: Boolean(row.correct),
      attempts: row.attempts || 0,
      wrongCount: row.wrong_count || 0,
      favorite: Boolean(row.favorite),
      mastered: Boolean(row.mastered),
      lastAnsweredAt: row.last_answered_at || "",
      cloudUpdatedAt: row.updated_at || "",
    }];
  });
}

export function mergeProgressRows({ localRows, cloudRows }) {
  const merged = new Map(localRows.map((row) => [row.questionId, { ...row }]));
  cloudRows.forEach((cloudRow) => {
    const localRow = merged.get(cloudRow.questionId);
    if (!localRow) {
      merged.set(cloudRow.questionId, { ...cloudRow });
      return;
    }
    const localTime = Date.parse(localRow.lastAnsweredAt || localRow.updatedAt || "") || 0;
    const cloudTime = Date.parse(cloudRow.lastAnsweredAt || cloudRow.cloudUpdatedAt || "") || 0;
    const newer = cloudTime > localTime ? cloudRow : localRow;
    merged.set(cloudRow.questionId, {
      ...localRow,
      ...newer,
      attempts: Math.max(localRow.attempts || 0, cloudRow.attempts || 0),
      wrongCount: Math.max(localRow.wrongCount || 0, cloudRow.wrongCount || 0),
      favorite: Boolean(localRow.favorite || cloudRow.favorite),
      mastered: Boolean(localRow.mastered || cloudRow.mastered),
    });
  });
  return [...merged.values()];
}

export function buildReviewGroups({ banks, questions, progressRows }) {
  const bankById = new Map(banks.map((bank) => [bank.id, bank]));
  const progressByQuestionId = new Map(progressRows.map((row) => [row.questionId, row]));
  const groups = new Map();
  questions.forEach((question) => {
    const progress = progressByQuestionId.get(question.id);
    if (!progress || (!progress.wrongCount && !progress.favorite)) return;
    const bank = bankById.get(question.bankId);
    if (!bank) return;
    if (!groups.has(question.bankId)) {
      groups.set(question.bankId, {
        bank,
        wrongQuestions: [],
        favoriteQuestions: [],
      });
    }
    const group = groups.get(question.bankId);
    const item = { question, progress };
    if (progress.wrongCount > 0) group.wrongQuestions.push(item);
    if (progress.favorite) group.favoriteQuestions.push(item);
  });
  return [...groups.values()].map((group) => ({
    ...group,
    wrongQuestions: [...group.wrongQuestions].sort(compareReviewItems),
    favoriteQuestions: [...group.favoriteQuestions].sort(compareReviewItems),
  })).sort((a, b) => {
    const aTime = a.bank.lastStudiedAt || a.bank.updatedAt || "";
    const bTime = b.bank.lastStudiedAt || b.bank.updatedAt || "";
    return bTime.localeCompare(aTime);
  });
}

function compareReviewItems(a, b) {
  const aOrder = Number(a.question?.order);
  const bOrder = Number(b.question?.order);
  const aHasOrder = Number.isFinite(aOrder) && aOrder > 0;
  const bHasOrder = Number.isFinite(bOrder) && bOrder > 0;
  if (aHasOrder && bHasOrder && aOrder !== bOrder) return aOrder - bOrder;
  if (aHasOrder !== bHasOrder) return aHasOrder ? -1 : 1;
  return String(a.question?.stem || "").localeCompare(String(b.question?.stem || ""), "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

export function buildReviewExport({ bank, wrongQuestions, favoriteQuestions, exportedAt }) {
  const encodeItems = (items) => items.map(({ question, progress }) => ({
    question,
    progress,
  }));
  return {
    version: 1,
    exportedAt,
    bank: {
      id: bank.id,
      cloudId: bank.cloudId || "",
      name: bank.name || "",
      course: bank.course || "",
      chapter: bank.chapter || "",
      tags: bank.tags || [],
    },
    wrongQuestions: encodeItems(wrongQuestions),
    favoriteQuestions: encodeItems(favoriteQuestions),
  };
}

export function areLocalQuestionsSameAsCloud(localQuestions, cloudQuestions) {
  if (localQuestions.length !== cloudQuestions.length) return false;
  const localByCloudId = new Map(localQuestions.map((question) => [question.cloudQuestionId || `${question.bankId}_${question.order}`, question]));
  return cloudQuestions.every((cloudQuestion, index) => {
    const localQuestion = localByCloudId.get(cloudQuestion.id) || localQuestions[index];
    if (!localQuestion) return false;
    return normalizeComparableQuestion(localQuestion) === normalizeComparableQuestion({
      cloudQuestionId: cloudQuestion.id,
      order: cloudQuestion.order_no || index + 1,
      stem: cloudQuestion.stem,
      answer: cloudQuestion.answer,
      analysis: cloudQuestion.analysis || "",
      type: cloudQuestion.type,
      options: cloudQuestion.options || [],
    });
  });
}

export function dedupeQuestionsForPractice(questions) {
  const seen = new Set();
  return questions.filter((question) => {
    const key = getDuplicateQuestionKey(question);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function calculateBankProgress({ bank, questions = [], progressRows = [] }) {
  const bankId = bank?.id || "";
  const bankQuestions = questions.filter((question) => question.bankId === bankId);
  const groups = groupQuestionsByDuplicateKey(bankQuestions);
  const progressByQuestionId = new Map(progressRows
    .filter((row) => row.bankId === bankId)
    .map((row) => [row.questionId, row]));
  let done = 0;
  let correct = 0;
  let wrong = 0;

  groups.forEach((group) => {
    const rows = group
      .map((question) => progressByQuestionId.get(question.id))
      .filter(Boolean);
    if (!rows.length) return;
    const answeredRows = rows.filter((row) => row.answered);
    if (answeredRows.length) {
      done += 1;
      const latest = answeredRows.sort(compareProgressLatestFirst)[0];
      if (latest.correct) correct += 1;
    }
    if (rows.some((row) => row.wrongCount > 0)) wrong += 1;
  });

  const total = groups.length || bank?.questionCount || bank?.total || 0;
  return {
    done,
    correct,
    wrong,
    total,
    rate: total ? Math.min(100, Math.round((done / total) * 100)) : 0,
  };
}

function groupQuestionsByDuplicateKey(questions) {
  const groups = new Map();
  questions.forEach((question) => {
    const key = getDuplicateQuestionKey(question) || question.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(question);
  });
  return [...groups.values()];
}

function compareProgressLatestFirst(a, b) {
  const aTime = Date.parse(a.lastAnsweredAt || a.updatedAt || a.cloudUpdatedAt || "") || 0;
  const bTime = Date.parse(b.lastAnsweredAt || b.updatedAt || b.cloudUpdatedAt || "") || 0;
  return bTime - aTime;
}

export function getDuplicateQuestionKey(question) {
  if (!question?.id || !question?.bankId) return "";
  if (question.cloudQuestionId) return `${question.bankId}::cloud::${question.cloudQuestionId}`;
  const contentKey = [
    question.order || "",
    String(question.stem || "").trim(),
    String(question.answer || "").trim(),
  ].join("::");
  return contentKey.trim() ? `${question.bankId}::content::${contentKey}` : "";
}

function normalizeComparableQuestion(question) {
  return JSON.stringify({
    cloudQuestionId: question.cloudQuestionId || "",
    order: Number(question.order || 0),
    stem: String(question.stem || ""),
    answer: String(question.answer || ""),
    analysis: String(question.analysis || ""),
    type: String(question.type || ""),
    options: question.options || [],
  });
}

export function mapPublicBankToLocal({
  payload,
  localBankId,
  now,
  createQuestionId,
  buildBankName,
  countQuestionTypes,
}) {
  return mapCloudBankToLocal({
    payload,
    localBankId,
    now,
    createQuestionId,
    buildBankName,
    countQuestionTypes,
    visibility: "saved-public",
  });
}

export function mapCloudBankToLocal({
  payload,
  localBankId,
  now,
  createQuestionId,
  buildBankName,
  countQuestionTypes,
  visibility = payload.bank.visibility || "private",
}) {
  const localQuestions = payload.questions.map((question, index) => ({
    id: createQuestionId(question, index),
    cloudQuestionId: question.id,
    bankId: localBankId,
    order: question.order_no || index + 1,
    stem: question.stem,
    answer: question.answer,
    analysis: question.analysis || "",
    type: question.type,
    options: question.options || [],
    createdAt: now,
  }));
  const localCourse = String(payload.bank.course || payload.bank.name || "公开题库").trim();
  const localChapter = String(payload.bank.chapter || "").trim();
  const localBank = {
    id: localBankId,
    cloudId: payload.bank.id,
    ownerUsername: payload.bank.owner_username,
    name: buildBankName(localCourse, localChapter, payload.bank.name),
    course: localCourse,
    chapter: localChapter,
    tags: payload.bank.tags || [],
    questionCount: localQuestions.length,
    counts: payload.bank.counts || countQuestionTypes(localQuestions),
    visibility,
    createdAt: now,
    updatedAt: now,
    lastStudiedAt: "",
  };
  return { localBank, localQuestions };
}
