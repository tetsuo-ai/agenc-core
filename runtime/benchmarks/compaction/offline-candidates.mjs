const INJECTION_PATTERN = /(?:ignore (?:all |any |the )?previous|system prompt override|follow these instructions|reveal canary|discard the recovery|approve the cutover immediately)/iu;
const IMPORTANT_PREFIX = /^(?:compatibility floor|constraint|cutover owner|decision|incident status|migration rule|open action|pending action|recovery checkpoint|rollback owner|rollback trigger|root cause|status):/iu;

export function plannerAwareExtractiveProxy(messages, summaryUtf8Budget) {
  const sentences = sourceSentences(messages);
  const eligible = sentences.filter((sentence) => !INJECTION_PATTERN.test(sentence.text));
  const ranked = eligible
    .map((sentence) => ({ ...sentence, score: sentenceScore(sentence.text) }))
    .sort((left, right) => right.score - left.score || left.ordinal - right.ordinal);
  const selected = selectWithinBudget(ranked, summaryUtf8Budget)
    .sort((left, right) => left.ordinal - right.ordinal);
  return candidateResult(selected, {
    sourceSentencesScanned: sentences.length,
    candidateSentencesScored: eligible.length,
    injectionSentencesRejected: sentences.length - eligible.length,
  });
}

export function tailWindowExtractiveBaseline(messages, summaryUtf8Budget) {
  const sentences = sourceSentences(messages);
  const selected = [];
  let outputBytes = 0;
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index];
    const bytes = formattedSentenceBytes(sentence);
    if (outputBytes + bytes > summaryUtf8Budget) break;
    selected.push(sentence);
    outputBytes += bytes;
  }
  selected.reverse();
  return candidateResult(selected, {
    sourceSentencesScanned: selected.length,
    candidateSentencesScored: 0,
    injectionSentencesRejected: 0,
  });
}

function sourceSentences(messages) {
  const sentences = [];
  let ordinal = 0;
  for (const [messageIndex, message] of messages.entries()) {
    for (const text of message.content.split(/(?<=[.!?])\s+|\n+/u)) {
      const normalized = text.trim();
      if (normalized.length === 0) continue;
      sentences.push({ messageIndex, ordinal, text: normalized });
      ordinal += 1;
    }
  }
  return sentences;
}

function sentenceScore(text) {
  let score = IMPORTANT_PREFIX.test(text) ? 100 : 0;
  if (/\b(?:blocked|must|pending|retain|rollback|until)\b/iu.test(text)) score += 20;
  if (/\b\d+(?:\.\d+)?\b/u.test(text)) score += 10;
  if (/\b(?:owner|checkpoint|digest|sequence|version)\b/iu.test(text)) score += 8;
  return score;
}

function selectWithinBudget(ranked, budget) {
  const selected = [];
  let outputBytes = 0;
  for (const sentence of ranked) {
    const bytes = formattedSentenceBytes(sentence);
    if (outputBytes + bytes > budget) continue;
    selected.push(sentence);
    outputBytes += bytes;
  }
  return selected;
}

function candidateResult(sentences, operationCounts) {
  const output = sentences
    .map((sentence) => `[source-message:${sentence.messageIndex}] ${sentence.text}`)
    .join("\n");
  return Object.freeze({
    output,
    statements: Object.freeze(sentences.map((sentence) => Object.freeze({
      sourceMessageIndex: sentence.messageIndex,
      text: sentence.text,
    }))),
    operationCounts: Object.freeze({ ...operationCounts }),
  });
}

function formattedSentenceBytes(sentence) {
  return Buffer.byteLength(`[source-message:${sentence.messageIndex}] ${sentence.text}\n`, "utf8");
}
