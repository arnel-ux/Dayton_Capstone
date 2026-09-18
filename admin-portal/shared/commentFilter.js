// ============================================================================
// commentFilter.js — what is allowed to appear as a written comment in a
// generated report, and how it is printed.
//
// A CQA report is a document that leaves the building: it is printed, signed
// and filed. Three kinds of row had no business being on it, and all three
// were reaching it:
//
//   1. "N/A", "none", "wala po", "-"  — a respondent declining to comment.
//      The report's comments section is the written feedback, so a decline is
//      not a short comment, it is the absence of one. Counting it as a row
//      also skewed the sentiment tallies printed beside the table.
//
//   2. "asdasdasd", "..", "qwerty", "zzzz" — a respondent typing something to
//      get past the field. There is no feedback in it to report.
//
//   3. Profanity. A real comment, genuinely submitted, and it belongs in the
//      record — but the record is /survey-records, where staff read responses
//      as they came in. The REPORT is the version that gets signed and filed,
//      and it is masked there.
//
// WHERE THIS SITS IN THE PIPELINE
// The AI classifier already catches (1) and (2) when it runs: analyze.py's
// detect_junk_topic returns the "No Feedback" topic for them, and the report
// queries drop anything with that topic (see NO_AI_RESULT_TOPIC_SQL in
// server.js). This module is the pass that does not depend on that having
// happened — the classifier is skipped for blank-looking comments, falls back
// to a flat "Neutral / General Feedback" whenever the model server and Gemini
// are both unreachable, and never ran at all on rows written before it
// existed. Any of those three paths puts a row on the report that the
// classifier would have caught. So the rules are checked again here, at the
// moment the report is built, where the answer cannot depend on what a
// background service was doing weeks ago.
//
// It is deliberately the CONSERVATIVE half of the classifier's rules. The
// Python side can afford to be sharper because it has a Tagalog/Bikol lexicon
// to confirm real content against first (keyword_topic_override /
// lexicon_sentiment); this module has no lexicon, so it only fires on shapes
// that a real sentence cannot have — every alphabetic token being a mash, a
// run of letters with essentially no vowels in it, nothing but punctuation.
// A borderline comment is kept. Dropping a real complaint from a quality
// assurance report is a far worse failure than printing one odd-looking row.
// ============================================================================

// ---------------------------------------------------------------------------
// 1. DECLINED TO COMMENT
// ---------------------------------------------------------------------------
// Whole-string matches only, against the normalized form below. These are
// phrases that mean "nothing to say" and nothing else — a comment that merely
// CONTAINS one of them ("N/A for the waiting time, but the staff were great")
// is a real comment and is kept.
//
// The Filipino entries are the half that was missing. The list was English
// only, so a respondent writing "wala po" — the ordinary way to say it here —
// had it printed as a written comment.
const NO_FEEDBACK_PHRASES = new Set([
    // English
    'na', 'n/a', 'n a', 'none', 'nil', 'no comment', 'no comments',
    'not applicable', 'nothing', 'nothing to say', 'no feedback',
    'no suggestion', 'no suggestions', 'no answer', 'blank', 'skip',
    // Filipino / Bikol
    'wala', 'wala po', 'wala naman', 'wala naman po', 'wala lang',
    'wala lang po', 'walang comment', 'walang komento', 'walang masabi',
    'walang suggestion', 'mayo', 'mayo po', 'mayong comment', 'dai', 'dai po'
]);

// Trim, lowercase, drop the punctuation people pad these with ("N/A.", "--",
// "none...") and collapse runs of whitespace. Kept identical on both sides of
// the wire: HAS_REAL_COMMENT_SQL in server.js is the SQL spelling of this same
// normalization, so a row excluded by the query and a row excluded here are
// excluded for the same reason.
function normalizeForFeedbackCheck(text) {
    return String(text)
        .trim()
        .toLowerCase()
        .replace(/[.\-]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// True when there is no written comment here to report: null, blank, pure
// punctuation, or one of the decline phrases above.
function isNoFeedbackComment(text) {
    if (text === null || text === undefined) return true;
    const trimmed = String(text).trim();
    if (trimmed === '') return true;
    const stripped = normalizeForFeedbackCheck(trimmed);
    if (stripped === '') return true; // "-", "--", "...", etc. reduce to nothing
    return NO_FEEDBACK_PHRASES.has(stripped);
}

// ---------------------------------------------------------------------------
// 2. NOT ACTUALLY WORDS
// ---------------------------------------------------------------------------
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

// Rows of a QWERTY keyboard, used to recognize a finger dragged along one.
// Checked in both directions, so "asdf" and "fdsa" both count.
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

// Short real words that the structural rules below would otherwise condemn,
// because they are short, vowel-poor, or both. Every one of these is a word a
// respondent genuinely might write on its own or in a two-word comment.
// Without this list, "ok ng serbisyo" would be three suspicious tokens and the
// whole comment would be dropped as a mash.
const KNOWN_SHORT_WORDS = new Set([
    // Tagalog/Bikol function words — "ng" and "mga" have no vowel at all
    'ng', 'mga', 'po', 'at', 'ay', 'sa', 'ko', 'mo', 'ka', 'na', 'nya', 'niya',
    'yung', 'ung', 'ito', 'yan', 'may', 'din', 'rin', 'pa', 'daw', 'raw',
    'kay', 'si', 'ni', 'ang', 'sya', 'nyo', 'ninyo', 'tayo', 'kami', 'sila',
    // Bikol
    'ta', 'ki', 'kan', 'sin', 'igwa', 'baga', 'man', 'nin',
    // Very common short English
    'ok', 'okay', 'good', 'nice', 'bad', 'yes', 'no', 'the', 'is', 'it', 'a',
    'i', 'we', 'to', 'of', 'in', 'on', 'be', 'so', 'as', 'by', 'up', 'thx',
    'cqa', 'sqd', 'id', 'hr', 'it', 'pc', 'tv', 'ac'
]);

// A finger run along one keyboard row: consecutive keys, all in the same
// direction. Real words essentially never do this at 4+ letters, which is why
// the minimum is deliberately that high.
function isKeyboardRun(token, minLen = 4) {
    const lowered = token.toLowerCase();
    if (lowered.length < minLen) return false;
    for (const row of KEYBOARD_ROWS) {
        const positions = Array.from(lowered, ch => row.indexOf(ch));
        if (positions.includes(-1)) continue;
        const steps = new Set();
        for (let k = 1; k < positions.length; k++) steps.add(positions[k] - positions[k - 1]);
        if (steps.size === 1 && (steps.has(1) || steps.has(-1))) return true;
    }
    return false;
}

// ["asd", 2] for "asdasd", ["a", 6] for "aaaaaa", ["asdkj", 2] for
// "asdkjasdkj"; null when the token is not one unit repeated end to end.
// Returns the SHORTEST unit that works, so "aaaa" comes back as ["a", 4]
// rather than ["aa", 2].
//
// The short sizes are the ones that need care: a 4-letter unit twice is also
// exactly how Filipino reduplication works ("halohalo", "arawaraw",
// "sarisari"), so the caller additionally requires a 3- or 4-letter unit to be
// a keyboard run before condemning it. None of those three words is one.
//
// Units longer than 4 are searched too — "asdkjasdkj" is a 5-letter mash typed
// twice and stopping at 4 missed it — and the caller judges those on the
// unit's own vowel ratio instead, because a long Filipino stem is reduplicated
// too ("bahaybahay", "tawantawan") and those are real words.
function repeatedUnit(token) {
    const lowered = token.toLowerCase();
    const half = Math.floor(lowered.length / 2);
    for (let size = 1; size <= half; size++) {
        if (lowered.length % size) continue;
        const unit = lowered.slice(0, size);
        if (unit.repeat(lowered.length / size) === lowered) {
            return [unit, lowered.length / size];
        }
    }
    return null;
}

function maxConsonantRun(lowered) {
    let best = 0;
    let current = 0;
    for (const ch of lowered) {
        if (VOWELS.has(ch)) current = 0;
        else { current += 1; if (current > best) best = current; }
    }
    return best;
}

// One token that cannot be a word. Mirrors _is_suspicious_token in
// ai_scripts/topic_common.py — the thresholds are uneven on purpose, and the
// reason is in that file: Tagalog and Bikol reduplication is real and has to
// survive. "mama" and "papa" are a 2-letter unit twice; "dagdag" and "pagpag"
// are a 3-letter unit twice. Neither shape may condemn a token on repetition
// alone, which is why a 3-letter unit additionally has to be a keyboard run.
function isSuspiciousToken(token) {
    const lowered = token.toLowerCase().replace(/[^a-z]/g, '');
    if (lowered.length < 2) return false;
    if (KNOWN_SHORT_WORDS.has(lowered)) return false;

    const vowelCount = Array.from(lowered).filter(c => VOWELS.has(c)).length;
    if (vowelCount === 0) return true;

    if (lowered.length >= 7 && maxConsonantRun(lowered) >= 5) return true;

    if (isKeyboardRun(lowered)) return true;

    const repeated = repeatedUnit(lowered);
    if (repeated) {
        const [unit, reps] = repeated;
        const unitHasVowel = Array.from(unit).some(c => VOWELS.has(c));
        if (unit.length <= 2 && reps >= 4) return true;
        if (unit.length <= 2 && reps >= 3 && (!unitHasVowel || isKeyboardRun(unit, 2))) return true;
        if (unit.length === 3 && reps >= 2 && isKeyboardRun(unit, 3)) return true;
        if (unit.length === 4 && reps >= 2 && isKeyboardRun(unit, 4)) return true;

        // A longer unit typed twice, judged on whether the unit could be a
        // word at all. Filipino reduplicates long stems as well, and those
        // stems are built from CV/CVC syllables, so they come out at roughly
        // 40% vowels or more — "bahay" is 2 in 5, "tawan" is 2 in 5, "sari" is
        // 2 in 4. A mash does not: "asdkj" is 1 in 5. The cut is at 25%, which
        // sits well clear of every real reduplication and still catches the
        // mash.
        if (unit.length >= 5 && reps >= 2) {
            const unitVowels = Array.from(unit).filter(c => VOWELS.has(c)).length;
            if (unitVowels / unit.length < 0.25) return true;
        }
    }

    return false;
}

// True when the comment as a whole carries no word in it. The two tests catch
// different shapes, and both require the WHOLE comment to fail — one odd token
// in an otherwise real sentence never drops the comment.
function isGibberishComment(text) {
    if (text === null || text === undefined) return false;
    const stripped = String(text).trim();
    if (stripped === '') return false; // blank is isNoFeedbackComment's job

    const letters = stripped.match(/[A-Za-z]/g) || [];
    const digits = stripped.match(/[0-9]/g) || [];

    // Nothing but emoji, symbols or punctuation.
    if (letters.length === 0 && digits.length === 0) return true;

    // Digits and separators only — a phone number, a date, a row of 1s.
    if (digits.length > 0 && letters.length === 0) {
        if (!stripped.replace(/[\d\s\-()+.]/g, '')) return true;
    }

    // A long run of letters with essentially no vowels in it. 10 letters is
    // high enough that no short real phrase reaches it by accident.
    if (letters.length >= 10) {
        const vowels = letters.filter(c => VOWELS.has(c.toLowerCase())).length;
        if (vowels / letters.length < 0.15) return true;
    }

    // Every alphabetic token is a mash. This is the test that catches
    // "asdasd", "qwertyuiop", "jkjkjkjk" — and the reason it is "every" and
    // not "any" is that one unrecognized token in a real sentence (a name, an
    // acronym, a typo) must not cost the comment its place in the report.
    const alphaTokens = (stripped.match(/[A-Za-z]+/g) || []).filter(t => t.length >= 2);
    if (alphaTokens.length > 0 && alphaTokens.every(isSuspiciousToken)) return true;

    // A comment made only of single letters: "a", "x x", "q w e". There is no
    // word in it, and the token test above skips tokens this short.
    if (alphaTokens.length === 0 && digits.length === 0 && letters.length > 0) return true;

    return false;
}

// ---------------------------------------------------------------------------
// 3. PROFANITY
// ---------------------------------------------------------------------------
// Matched against a NORMALIZED token (see normalizeToken): lowercased,
// accents removed, the usual character swaps undone, and repeated letters
// collapsed — so "P U T A", "pvta", "put@", "tangináaaa" and "SHIIIIT" all
// reduce to the same thing the list holds.

// Exact matches. A token has to BE one of these, which is what keeps
// "reputation" (which contains "puta") and "class" (which contains "ass") out
// of it — the mistake any substring-based filter makes on its first day.
const PROFANITY_EXACT = new Set([
    // English
    'fuck', 'fucks', 'fucked', 'fuckin', 'fucking', 'fucker', 'fuckers',
    'motherfucker', 'motherfucking', 'shit', 'shits', 'shitty', 'bullshit',
    'bitch', 'bitches', 'bastard', 'asshole', 'assholes', 'dumbass', 'jackass',
    'dick', 'dickhead', 'cunt', 'slut', 'whore', 'douchebag',
    'damn', 'goddamn', 'piss', 'pissed', 'crap', 'wtf', 'stfu',
    'idiot', 'idiots', 'stupid', 'moron', 'morons', 'retard', 'retarded',
    // Filipino / Bikol
    'puta', 'putah', 'putangina', 'putanginamo', 'putangna', 'putcha',
    'tangina', 'tanginamo', 'taena', 'tarantado', 'tarantada',
    'gago', 'gaga', 'gagu', 'gagong', 'gagang', 'ulol', 'ulul',
    'bwisit', 'buwisit', 'punyeta', 'puneta', 'letse', 'lintik',
    'hinayupak', 'kupal', 'kingina', 'kinginamo',
    'pakyu', 'pakshet', 'pucha', 'yawa',
    'bobo', 'boba', 'bobong', 'tanga', 'tangang', 'engot', 'inutil',
    'bwiset', 'pesteng', 'gunggong', 'siraulo',
    'burat', 'titi', 'pekpek', 'kantot', 'jakol', 'bayag', 'tite'
]);

// DELIBERATELY NOT ON THE LIST, and each for the same reason — this is an
// agricultural and polytechnic college, and these are ordinary vocabulary in
// the offices this survey covers:
//
//   animal, hayop  Insults in Filipino, and also the literal subject matter
//                  of the Animal Science department.
//   cock           Only a vulgarity in American English; here it is a rooster.
//   peste          An insult as "pesteng ~" (which IS listed), but on its own
//                  it is a crop pest.
//   leche          A swear as "letse" (listed), but "leche flan" is on the
//                  canteen menu.
//   bloody         A British swear, and a word a clinic comment may need.
//
// Masking one of these turns a legitimate complaint into asterisks, which is
// worse than printing a mild word: the report exists to surface complaints.

// Prefix matches, for the words that take Filipino suffixes and enclitics
// ("gagong", "tanginamo", "putanginamo", "bwisit na bwisit"). Every entry here
// was checked for being a prefix of an innocent word first — which is why
// "puta" is exact-only above (it would have taken "putahe") while "putang"
// is safe here.
const PROFANITY_PREFIXES = [
    'putangina', 'putangna', 'putang', 'tangina', 'tangna',
    'kingina', 'kinginang', 'motherfuck', 'fuckin', 'asshol',
    'gagong', 'tarantad', 'hinayupak', 'punyet', 'pakyu'
];

// Phrases that are only profane as a phrase — each word in them is ordinary
// on its own, so nothing above would catch them. Written normalized and
// space-separated; matched across adjacent tokens, so the spacing in the
// original does not matter.
//
// Nothing goes in this list whose words are ALREADY caught individually. A
// phrase masks every token in it, so listing "what the fuck" here would print
// "**** *** **** is this" — three words gone to remove one. "fuck" is in the
// exact list; the phrase adds nothing but collateral.
const PROFANITY_PHRASES = [
    'putang ina', 'tang ina', 'sira ulo'
];

// Characters people substitute to slip a word past a filter, and the letters
// they stand in for.
const LEET_MAP = {
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
    '@': 'a', '$': 's', '!': 'i', '|': 'l', '+': 't', '*': ''
};

function normalizeToken(token) {
    return token
        .toLowerCase()
        // Strip accents ("tanginá" -> "tangina") without needing a lookup table.
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[0134578@$!|+*]/g, ch => (ch in LEET_MAP ? LEET_MAP[ch] : ch))
        .replace(/[^a-z]/g, '')
        // "shiiiit" -> "shiit". Collapsed to TWO, not one, so real double
        // letters ("assess", "letse") are left intact.
        .replace(/(.)\1{2,}/g, '$1$1');
}

function isProfaneToken(normalized) {
    if (normalized.length < 2) return false;
    if (PROFANITY_EXACT.has(normalized)) return true;
    // A doubled letter that the collapse above left in place can still be the
    // difference between "shiit" and "shit", so try the fully-collapsed form
    // as well before giving up.
    const single = normalized.replace(/(.)\1+/g, '$1');
    if (PROFANITY_EXACT.has(single)) return true;
    return PROFANITY_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

// Replaces every profane word with asterisks, one per character, and leaves
// the rest of the comment exactly as written. Asterisks rather than removing
// the word outright: the reader of a signed report should be able to see that
// something was said and taken out, not read a sentence quietly missing a
// piece. Length is preserved for the same reason — the shape of what was
// written stays visible.
//
// Returns { text, maskedCount } so the caller can log or count how much of a
// reporting period needed masking without re-scanning the text.
function maskProfanity(text) {
    if (text === null || text === undefined) return { text: '', maskedCount: 0 };
    const original = String(text);

    // Split keeping the separators, so the original spacing and punctuation
    // can be put back exactly: even indices are word tokens, odd are the gaps
    // between them.
    const parts = original.split(/([^\p{L}\p{N}@$*!|+]+)/u);
    const isWord = i => i % 2 === 0 && parts[i].length > 0;

    const normalized = parts.map((part, i) => (isWord(i) ? normalizeToken(part) : null));
    const doMask = new Array(parts.length).fill(false);

    // Pass 1 — phrases, first, because a phrase can span tokens that are each
    // innocent on their own ("tang" + "ina").
    const wordIndices = [];
    for (let i = 0; i < parts.length; i++) if (isWord(i) && normalized[i]) wordIndices.push(i);

    for (const phrase of PROFANITY_PHRASES) {
        const words = phrase.split(' ');
        for (let start = 0; start + words.length <= wordIndices.length; start++) {
            let hit = true;
            for (let k = 0; k < words.length; k++) {
                if (normalized[wordIndices[start + k]] !== words[k]) { hit = false; break; }
            }
            if (hit) {
                for (let k = 0; k < words.length; k++) doMask[wordIndices[start + k]] = true;
            }
        }
    }

    // Pass 2 — single words.
    for (const i of wordIndices) {
        if (!doMask[i] && isProfaneToken(normalized[i])) doMask[i] = true;
    }

    let maskedCount = 0;
    const out = parts.map((part, i) => {
        if (!doMask[i]) return part;
        maskedCount += 1;
        return '*'.repeat(part.length);
    }).join('');

    return { text: out, maskedCount };
}

function containsProfanity(text) {
    return maskProfanity(text).maskedCount > 0;
}

// ---------------------------------------------------------------------------
// THE ONE CALL A REPORT MAKES
// ---------------------------------------------------------------------------
// Takes a raw stored comment, answers whether it belongs on a report and, if
// it does, hands back the text to print. Reports go through this rather than
// calling the three rules separately, so a report added later cannot end up
// applying two of the three.
//
//   { include: false }                      -> leave the row off entirely
//   { include: true, text, wasMasked }      -> print `text`, never the original
function prepareReportComment(text) {
    if (isNoFeedbackComment(text)) return { include: false, reason: 'no-feedback', text: '', wasMasked: false };
    if (isGibberishComment(text)) return { include: false, reason: 'gibberish', text: '', wasMasked: false };

    const { text: masked, maskedCount } = maskProfanity(text);
    return { include: true, reason: null, text: masked, wasMasked: maskedCount > 0 };
}

module.exports = {
    NO_FEEDBACK_PHRASES,
    isNoFeedbackComment,
    isGibberishComment,
    isSuspiciousToken,
    maskProfanity,
    containsProfanity,
    prepareReportComment
};
