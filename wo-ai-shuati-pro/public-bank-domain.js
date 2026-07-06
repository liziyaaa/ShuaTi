export function isProfileComplete(profile) {
  return Boolean(String(profile?.username || "").trim() && String(profile?.display_name || "").trim());
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
  return [...groups.values()].sort((a, b) => {
    const aTime = a.bank.lastStudiedAt || a.bank.updatedAt || "";
    const bTime = b.bank.lastStudiedAt || b.bank.updatedAt || "";
    return bTime.localeCompare(aTime);
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

function getDuplicateQuestionKey(question) {
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
