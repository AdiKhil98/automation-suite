import { RENDER_BOILERPLATE_PHRASES, RENDER_GREETING_WORDS } from './email-render.js';

/**
 * DETERMINISTIC ANTI-REPLAY GATE for follow-ups.
 *
 * A Follow-up #2 that says the same thing as Outreach #1 in different words is worthless to the
 * recipient, and in production one was written, approved by the reviewer, and caught only in human
 * review. This gate is the deterministic half of the answer: pure lexical comparison between the
 * candidate body and the bodies already SENT in the thread. No model, no embeddings, no network, no
 * cost — it runs inside `validateEmail`, before the reviewer is ever called.
 *
 * IT IS NOT "EVERY FOLLOW-UP MUST ADD SOMETHING". Each step has its own job, and two of them are
 * explicitly not about new material:
 *
 *   step 1 (Follow-up #2)  ADD CLARITY            -> replay refused AND new content required
 *   step 2 (Follow-up #3)  COMPRESS, REDUCE PRESSURE -> replay refused; a short compression that
 *                                                    says nothing new is the job, not a failure
 *   step 3 (Follow-up #4)  BINARY YES/NO CLOSE    -> replay refused; a close carries no new
 *                                                    business information by design
 *
 * So the novelty floor belongs to step 1 alone. Applying it to a compression or a close would
 * deterministically reject copy that is doing exactly what its lesson job asks for.
 *
 * WHAT IT IS FOR, AND WHAT IT IS NOT FOR. Lexical comparison cannot detect a true synonym paraphrase
 * ("cookie banner" -> "consent notice"), and pretending otherwise would mean tuning thresholds until
 * they fire on legitimate copy. It is deliberately CONSERVATIVE: it catches a follow-up that REPLAYS
 * prior wording or contributes essentially no new content. Judging whether a genuinely reworded
 * message teaches the prospect anything new is the reviewer's job (`addsClarityNotRestart`), and the
 * two layers are complementary — this one cannot be talked out of its verdict, that one can read.
 *
 * REFERENCE vs RESTATE. A follow-up MUST be free to name the same issue: "cookie banner", "mobile",
 * the business name and the thread subject are the shared subject of the conversation, and a gate
 * that punished them would forbid continuity. So the comparison is not "shared words": it asks
 * whether whole CLAUSES come back, whether most of the candidate's phrasing is recycled, and whether
 * anything new is said at all.
 */

/**
 * Every threshold, named and justified. They are deliberately generous: a false positive blocks copy
 * that a human would have accepted, which is worse here than a false negative the reviewer still has
 * a chance to catch.
 */
export const REPETITION_LIMITS = {
  /**
   * Longest run of consecutive CONTENT words (stopwords removed) the candidate may share with
   * something already sent. Against the authoritative text, naming the same issue costs one or two
   * shared words and the production rewrite reaches three — it rephrased rather than lifted, and is
   * caught by the reuse ratio below instead. Four consecutive content words is no longer a shared
   * noun or a quoted control label; it is a lifted fragment, and the step-2 and step-3
   * re-explanations measured here reach six and four.
   */
  maxSharedContentRun: 4,
  /**
   * Share of the candidate's content BIGRAMS that already appear in a sent message. Catches a
   * message reassembled from prior phrasing even when no single run is long, and it is what catches
   * the production failure: measured against the AUTHORITATIVE stored Outreach #1, that rewrite
   * scores 0.23 while every legitimate follow-up measured scores 0.06 or less (genuine clarification
   * 0.05, new-layer 0.00, a step-2 compression and a step-3 close both 0.00). The threshold sits in
   * the middle of that gap rather than at its edge, so neither side is decided by a hair.
   */
  maxSharedBigramRatio: 0.15,
  /**
   * How many content words the candidate must contribute that were NOT in any sent message. This is
   * the "did the prospect learn anything?" floor, and it is what catches a short "just following up
   * on the cookie banner" that reuses nothing verbatim because it says almost nothing at all.
   * STEP 1 ONLY — see {@link repetitionPolicyFor}.
   */
  minNovelContentTokens: 4,
  /**
   * Below this many content words the candidate is too short to analyse for phrase reuse, but the
   * novelty floor above still applies — a two-line nudge is exactly the case that must not slip
   * through on "too short to judge".
   */
  minContentTokensForPhraseAnalysis: 10,
} as const;

/**
 * Which checks apply at a given step. Derived from the lesson job, not from preference: only the
 * step whose job is to ADD something is asked whether it added anything.
 */
export interface RepetitionPolicy {
  /** A clause lifted from an earlier email is wrong at every follow-up position. */
  detectClauseReplay: boolean;
  /** Rebuilding the previous email out of its own phrases is wrong at every follow-up position. */
  detectPervasiveReuse: boolean;
  /** Only step 1 owes the recipient new understanding. */
  requireNovelty: boolean;
}

export function repetitionPolicyFor(step: number): RepetitionPolicy {
  return {
    detectClauseReplay: true,
    detectPervasiveReuse: true,
    // Step 1's job is ADD CLARITY. Step 2 compresses and step 3 closes — neither is allowed to add
    // new value, so neither can be required to.
    requireNovelty: step === 1,
  };
}

/** Why a candidate was judged a repeat. Each maps to exactly one threshold above. */
export type RepetitionReason =
  /** A run of consecutive content words from a previous email came back intact. */
  | 'VERBATIM_CLAUSE_REPLAY'
  /** Most of the candidate's phrasing is recycled from previous emails. */
  | 'PERVASIVE_PHRASE_REUSE'
  /** The candidate contributes almost no content that was not already sent. */
  | 'NO_NEW_CONTENT';

export interface RepetitionAnalysis {
  repeats: boolean;
  reason: RepetitionReason | null;
  /** Longest shared run of consecutive content words. */
  longestSharedRun: number;
  /** Share (0-1) of candidate content bigrams that already appear in a sent message. */
  sharedBigramRatio: number;
  /** Content words the candidate adds that no sent message contained. */
  novelContentTokens: number;
  /** Content words in the candidate after boilerplate, subject and stopword removal. */
  candidateContentTokens: number;
  /** Set when the candidate was too short for phrase analysis (a compression or a close usually is). */
  tooShortForPhraseAnalysis: boolean;
  /** The checks that actually applied, so a verdict can be explained without re-deriving it. */
  policy: RepetitionPolicy;
}

export interface RepetitionInput {
  /** Which follow-up this is. Decides which checks apply — see {@link repetitionPolicyFor}. */
  step: number;
  /** The model's `email_body` for the candidate follow-up. */
  candidateBody: string;
  /** Bodies already SENT in this thread — rendered emails, greetings and signoffs included. */
  priorBodies: readonly string[];
  /**
   * The thread subject, excluded from the comparison: every follow-up legitimately continues it, so
   * counting it as reuse would penalise correct threading.
   */
  threadSubject?: string | null;
}

/**
 * Words that carry no content. Both languages the pipeline writes in, because a German thread must
 * be judged by the same rule as an English one. Deliberately ordinary-language: this list exists to
 * remove grammar, not to remove meaning.
 */
/**
 * A greeting line, in any language the renderer greets in, named or not. Built from the greeting
 * words the renderer actually uses so the two can never drift apart.
 */
const GREETING_LINE_RE = new RegExp(
  `^\\s*(?:${RENDER_GREETING_WORDS.join('|')})\\b[^\\n]*$`,
  'gim',
);

const STOPWORDS = new Set([
  // English
  'a', 'about', 'above', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'just', 'me', 'more', 'most', 'my', 'no', 'nor', 'not', 'now', 'of', 'off', 'on',
  'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'out', 'over', 'own', 'rather', 'same',
  'she', 'should', 'simply', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up',
  'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why',
  'will', 'with', 'would', 'you', 'your', 'yours',
  // German
  'aber', 'als', 'am', 'an', 'auch', 'auf', 'aus', 'bei', 'bin', 'bis', 'da', 'dass', 'dem', 'den',
  'der', 'des', 'die', 'das', 'doch', 'durch', 'ein', 'eine', 'einem', 'einen', 'einer', 'eines',
  'er', 'es', 'für', 'hat', 'haben', 'ich', 'ihr', 'ihre', 'im', 'in', 'ist', 'kann', 'man', 'mit',
  'nach', 'nicht', 'noch', 'nur', 'oder', 'sich', 'sie', 'sind', 'über', 'um', 'und', 'von', 'vor',
  'war', 'wenn', 'werden', 'wie', 'wir', 'wird', 'zu', 'zum', 'zur',
]);

/**
 * Crude suffix folding so "patients"/"patient" and "understand"/"understanding" are the same token.
 * Not a linguistic stemmer and not trying to be: it exists so trivial inflection cannot disguise a
 * replayed clause. Short words are left alone, which keeps it from mangling real nouns.
 */
function fold(token: string): string {
  for (const suffix of ['ungen', 'ing', 'ed', 'es', 'en', 's']) {
    if (token.length > suffix.length + 3 && token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

/** Lowercase, strip typography and punctuation, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The substantive words of a message: rendered boilerplate removed (greeting, CTA sentence,
 * signoff, sender token), then the thread subject, then punctuation, stopwords and inflection.
 */
export function contentTokens(text: string, threadSubject?: string | null): string[] {
  // A rendered email opens with a greeting line that may carry a NAME ("Hello Dr Richard,"). Phrase
  // stripping cannot match that — the name is lead data, not a fixed phrase — so the whole greeting
  // LINE is removed by shape: a line that starts with a known greeting word. Generic by
  // construction; no prospect name is ever referenced here.
  let stripped = text.replace(GREETING_LINE_RE, ' ');
  for (const phrase of RENDER_BOILERPLATE_PHRASES) {
    stripped = stripped.split(phrase).join(' ');
  }
  const subjectTokens = new Set(
    threadSubject ? normalize(threadSubject).split(' ').filter(Boolean).map(fold) : [],
  );
  return normalize(stripped)
    .split(' ')
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .map(fold)
    .filter((t) => t.length > 1 && !subjectTokens.has(t) && !STOPWORDS.has(t));
}

function bigrams(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) out.push(`${tokens[i]!} ${tokens[i + 1]!}`);
  return out;
}

/** Longest run of consecutive candidate tokens that appears, in order, in a prior message. */
function longestSharedRun(candidate: readonly string[], prior: readonly string[][]): number {
  let longest = 0;
  for (const previous of prior) {
    // Classic longest-common-substring over token arrays; message bodies are small.
    const table: number[][] = Array.from({ length: candidate.length + 1 }, () => new Array<number>(previous.length + 1).fill(0));
    for (let i = 1; i <= candidate.length; i += 1) {
      for (let j = 1; j <= previous.length; j += 1) {
        if (candidate[i - 1] === previous[j - 1]) {
          const run = table[i - 1]![j - 1]! + 1;
          table[i]![j] = run;
          if (run > longest) longest = run;
        }
      }
    }
  }
  return longest;
}

/**
 * Compare a candidate follow-up body against what was already sent. Pure and deterministic: the same
 * inputs always produce the same verdict, and nothing here can spend money or reach the network.
 */
export function analyzeFollowupRepetition(input: RepetitionInput): RepetitionAnalysis {
  const candidate = contentTokens(input.candidateBody, input.threadSubject);
  const prior = input.priorBodies.map((body) => contentTokens(body, input.threadSubject));
  const priorTokens = new Set(prior.flat());

  const novelContentTokens = new Set(candidate.filter((t) => !priorTokens.has(t))).size;
  const candidateBigrams = bigrams(candidate);
  const priorBigrams = new Set(prior.flatMap((tokens) => bigrams(tokens)));
  const sharedBigrams = candidateBigrams.filter((b) => priorBigrams.has(b)).length;
  const sharedBigramRatio = candidateBigrams.length === 0 ? 0 : sharedBigrams / candidateBigrams.length;
  const run = longestSharedRun(candidate, prior);
  const tooShort = candidate.length < REPETITION_LIMITS.minContentTokensForPhraseAnalysis;

  const policy = repetitionPolicyFor(input.step);
  const analysis: RepetitionAnalysis = {
    repeats: false,
    reason: null,
    longestSharedRun: run,
    sharedBigramRatio,
    novelContentTokens,
    candidateContentTokens: candidate.length,
    tooShortForPhraseAnalysis: tooShort,
    policy,
  };

  // Nothing already sent means nothing to repeat.
  if (prior.length === 0 || priorTokens.size === 0) return analysis;

  // STEP 1 ONLY: the "did the prospect learn anything?" floor. It applies at every length, because
  // the message that adds nothing while reusing almost no wording is exactly the short nudge.
  if (policy.requireNovelty && novelContentTokens < REPETITION_LIMITS.minNovelContentTokens) {
    return { ...analysis, repeats: true, reason: 'NO_NEW_CONTENT' };
  }

  // Phrase analysis needs enough words to be meaningful: on a two-line message a single shared
  // bigram is a third of the text. A legitimate compression (step 2) or close (step 3) lives here,
  // and must not be failed for being short.
  if (tooShort) return analysis;

  if (policy.detectClauseReplay && run >= REPETITION_LIMITS.maxSharedContentRun) {
    return { ...analysis, repeats: true, reason: 'VERBATIM_CLAUSE_REPLAY' };
  }
  if (policy.detectPervasiveReuse && sharedBigramRatio >= REPETITION_LIMITS.maxSharedBigramRatio) {
    return { ...analysis, repeats: true, reason: 'PERVASIVE_PHRASE_REUSE' };
  }
  return analysis;
}
