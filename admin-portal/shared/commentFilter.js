// Decides what's allowed to appear as a written comment in a generated
// report, and masks profanity while keeping the comment itself.
// Filters out decline-to-comment phrases, gibberish, and stars out profanity
// by vowel instead of dropping the whole word.

// ---------------------------------------------------------------------------
// 1. DECLINED TO COMMENT
// ---------------------------------------------------------------------------
// Whole-string phrases meaning "nothing to say", checked after normalizing.
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

// Trims, lowercases, and strips stray punctuation for the feedback-phrase check.
function normalizeForFeedbackCheck(text) {
    return String(text)
        .trim()
        .toLowerCase()
        .replace(/[.\-]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// True when there's no written comment to report: null, blank, or a decline phrase.
function isNoFeedbackComment(text) {
    if (text === null || text === undefined) return true;
    const trimmed = String(text).trim();
    if (trimmed === '') return true;
    const stripped = normalizeForFeedbackCheck(trimmed);
    if (stripped === '') return true;
    return NO_FEEDBACK_PHRASES.has(stripped);
}

// ---------------------------------------------------------------------------
// 2. NOT ACTUALLY WORDS
// ---------------------------------------------------------------------------
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

// Rows of a QWERTY keyboard, for spotting a finger dragged along one.
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

// Short real words that would otherwise get flagged as suspicious.
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

// True if the token is a run of consecutive keys along one keyboard row.
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

// Finds the shortest repeating unit that makes up the whole token, if any.
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

// True for one token that looks like gibberish rather than a real word.
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

        // A longer unit typed twice, judged by its own vowel ratio.
        if (unit.length >= 5 && reps >= 2) {
            const unitVowels = Array.from(unit).filter(c => VOWELS.has(c)).length;
            if (unitVowels / unit.length < 0.25) return true;
        }
    }

    return false;
}

// True when the whole comment carries no real word in it.
function isGibberishComment(text) {
    if (text === null || text === undefined) return false;
    const stripped = String(text).trim();
    if (stripped === '') return false;

    const letters = stripped.match(/[A-Za-z]/g) || [];
    const digits = stripped.match(/[0-9]/g) || [];

    if (letters.length === 0 && digits.length === 0) return true;

    if (digits.length > 0 && letters.length === 0) {
        if (!stripped.replace(/[\d\s\-()+.]/g, '')) return true;
    }

    if (letters.length >= 10) {
        const vowels = letters.filter(c => VOWELS.has(c.toLowerCase())).length;
        if (vowels / letters.length < 0.15) return true;
    }

    const alphaTokens = (stripped.match(/[A-Za-z]+/g) || []).filter(t => t.length >= 2);
    if (alphaTokens.length > 0 && alphaTokens.every(isSuspiciousToken)) return true;

    if (alphaTokens.length === 0 && digits.length === 0 && letters.length > 0) return true;

    return false;
}

// ---------------------------------------------------------------------------
// 3. PROFANITY
// ---------------------------------------------------------------------------
// Matched against a normalized token: lowercased, accents removed, common
// character swaps undone, repeated letters collapsed.

// Exact-match profanity list.
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
    'gagi', 'hangal',
    'bwiset', 'pesteng', 'gunggong', 'siraulo',
    'burat', 'titi', 'pekpek', 'kantot', 'jakol', 'bayag', 'tite'
]);

// Words deliberately left off the list because they're ordinary vocabulary
// here (animal/hayop, cock, peste, leche, bloody).

// Prefix matches, for words that take Filipino suffixes and enclitics.
const PROFANITY_PREFIXES = [
    'putangina', 'putangna', 'putang', 'tangina', 'tangna',
    'kingina', 'kinginang', 'motherfuck', 'fuckin', 'asshol',
    'gagong', 'tarantad', 'hinayupak', 'punyet', 'pakyu'
];

// Phrases that are only profane together, each word being harmless alone.
const PROFANITY_PHRASES = [
    'putang ina', 'tang ina', 'sira ulo'
];

// Characters people substitute for letters to slip a word past a filter.
const LEET_MAP = {
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
    '@': 'a', '$': 's', '!': 'i', '|': 'l', '+': 't', '*': ''
};

// Lowercases, strips accents, undoes leet substitutions, and collapses
// stretched-out repeated letters ("shiiiit" -> "shiit").
function normalizeToken(token) {
    return token
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[0134578@$!|+*]/g, ch => (ch in LEET_MAP ? LEET_MAP[ch] : ch))
        .replace(/[^a-z]/g, '')
        .replace(/(.)\1{2,}/g, '$1$1');
}

// ---------------------------------------------------------------------------
// 3b. THE SAME WORD, WITH FILIPINO AFFIXES ON IT
// ---------------------------------------------------------------------------
// Root words that count as profane once Filipino prefixes/suffixes are peeled off.
const PROFANITY_AFFIXABLE_ROOTS = new Set([
    'bobo', 'boba', 'tanga', 'gago', 'gaga', 'gagi', 'gagu',
    'ulol', 'ulul', 'engot', 'inutil', 'hangal', 'gunggong',
    'tarantado', 'tarantada', 'kupal', 'hinayupak', 'siraulo',
    'bwisit', 'buwisit', 'punyeta'
]);

// Prefixes a respondent might put on these words.
const AFFIX_PREFIXES = [
    '', 'ka', 'pagka', 'napaka', 'pinaka', 'sobrang',
    'mag', 'nag', 'ma', 'na', 'pag', 'maka', 'naka', 'pina',
    'pang', 'mang', 'nang', 'ipag'
];

// Suffixes and the -ng linker a respondent might put on these words.
const AFFIX_SUFFIXES = ['', 'han', 'hin', 'an', 'in', 'ng', 'g'];

function hasProfaneRoot(normalized) {
    for (const prefix of AFFIX_PREFIXES) {
        if (prefix && !normalized.startsWith(prefix)) continue;
        const afterPrefix = normalized.slice(prefix.length);

        for (const suffix of AFFIX_SUFFIXES) {
            if (suffix && !afterPrefix.endsWith(suffix)) continue;
            if (!prefix && !suffix) continue;

            const root = afterPrefix.slice(0, afterPrefix.length - suffix.length);
            if (root.length < 3) continue;

            if (PROFANITY_AFFIXABLE_ROOTS.has(root)) return true;

            // Filipino raises a final "o" to "u" before a suffix ("gago" -> "gaguhan").
            const restored = root.replace(/u([^u]*)$/, 'o$1');
            if (restored !== root && PROFANITY_AFFIXABLE_ROOTS.has(restored)) return true;
        }
    }
    return false;
}

function isProfaneToken(normalized) {
    if (normalized.length < 2) return false;
    if (PROFANITY_EXACT.has(normalized)) return true;
    const single = normalized.replace(/(.)\1+/g, '$1');
    if (PROFANITY_EXACT.has(single)) return true;
    if (PROFANITY_PREFIXES.some(prefix => normalized.startsWith(prefix))) return true;
    return hasProfaneRoot(normalized);
}

// True for a vowel character, including accented forms and digit/symbol
// stand-ins for vowels.
function isVowelChar(ch) {
    const folded = ch.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (VOWELS.has(folded)) return true;
    const substituted = LEET_MAP[folded];
    return substituted !== undefined && VOWELS.has(substituted);
}

// Stars out one profane word through its vowels, keeping its shape readable.
function maskVowels(word) {
    let masked = 0;
    const out = Array.from(word.normalize('NFC'), (ch) => {
        if (!isVowelChar(ch)) return ch;
        masked += 1;
        return '*';
    }).join('');
    return masked > 0 ? out : '*'.repeat(word.length);
}

// Masks the vowels of every profane word in a comment and leaves the rest as written.
function maskProfanity(text) {
    if (text === null || text === undefined) return { text: '', maskedCount: 0 };
    const original = String(text);

    // Split keeping separators so spacing/punctuation can be put back exactly.
    const parts = original.split(/([^\p{L}\p{N}@$*!|+]+)/u);
    const isWord = i => i % 2 === 0 && parts[i].length > 0;

    const normalized = parts.map((part, i) => (isWord(i) ? normalizeToken(part) : null));
    const doMask = new Array(parts.length).fill(false);

    // Pass 1: phrases, since a phrase can span tokens that are innocent alone.
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

    // Pass 2: single words.
    for (const i of wordIndices) {
        if (!doMask[i] && isProfaneToken(normalized[i])) doMask[i] = true;
    }

    let maskedCount = 0;
    const out = parts.map((part, i) => {
        if (!doMask[i]) return part;
        maskedCount += 1;
        return maskVowels(part);
    }).join('');

    return { text: out, maskedCount };
}

function containsProfanity(text) {
    return maskProfanity(text).maskedCount > 0;
}

// ---------------------------------------------------------------------------
// THE ONE CALL A REPORT MAKES
// ---------------------------------------------------------------------------
// Takes a raw comment and decides whether it belongs on a report, returning the text to print.
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
