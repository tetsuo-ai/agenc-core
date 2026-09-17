/**
 * Secret sanitizer for AgenC log and artifact payloads.
 *
 * Why this lives here:
 *   - AgenC consumers persist structured JSON events, so this module redacts
 *     both raw strings and nested JSON-like values.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Local encrypted secret storage; SE-01 owns
 *     sanitizer behavior for logs, transcripts, hook output, and traces.
 */

export const REDACTED_SECRET = "[REDACTED_SECRET]";

// Canonical BIP39 English wordlist (2048 words) from bitcoin/bips bip-0039.
// Used to detect bare mnemonic / seed phrases (a contiguous run of 12/15/18/21/24
// valid lowercase BIP39 words) so wallet seed phrases are redacted even when no
// surrounding key name is present. Matching the full wordlist (rather than a
// generic "N lowercase words" heuristic) keeps ordinary prose from being redacted.
const BIP39_WORDLIST: ReadonlySet<string> = new Set(
  (
    "abandon ability able about above absent absorb abstract absurd abuse access accident account " +
    "accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict " +
    "address adjust admit adult advance advice aerobic affair afford afraid again age agent agree " +
    "ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone " +
    "alpha already also alter always amateur amazing among amount amused analyst anchor ancient " +
    "anger angle angry animal ankle announce annual another answer antenna antique anxiety any " +
    "apart apology appear apple approve april arch arctic area arena argue arm armed armor army " +
    "around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset " +
    "assist assume asthma athlete atom attack attend attitude attract auction audit august aunt " +
    "author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby " +
    "bachelor bacon badge bag balance balcony ball bamboo banana banner bar barely bargain barrel " +
    "base basic basket battle beach bean beauty because become beef before begin behave behind " +
    "believe below belt bench benefit best betray better between beyond bicycle bid bike bind " +
    "biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom " +
    "blouse blue blur blush board boat body boil bomb bone bonus book boost border boring borrow " +
    "boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief " +
    "bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget " +
    "buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter " +
    "buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy " +
    "cannon canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart " +
    "case cash casino castle casual cat catalog catch category cattle caught cause caution cave " +
    "ceiling celery cement census century cereal certain chair chalk champion change chaos " +
    "chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney " +
    "choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim " +
    "clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog " +
    "close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin " +
    "collect color column combine come comfort comic common company concert conduct confirm " +
    "congress connect consider control convince cook cool copper copy coral core corn correct " +
    "cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane " +
    "crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross " +
    "crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard " +
    "curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring " +
    "dash daughter dawn day deal debate debris decade december decide decline decorate decrease " +
    "deer defense define defy degree delay deliver demand demise denial dentist deny depart " +
    "depend deposit depth deputy derive describe desert design desk despair destroy detail detect " +
    "develop device devote diagram dial diamond diary dice diesel diet differ digital dignity " +
    "dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display " +
    "distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey " +
    "donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink " +
    "drip drive drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle " +
    "early earn earth easily east easy echo ecology economy edge edit educate effort egg eight " +
    "either elbow elder electric elegant element elephant elevator elite else embark embody " +
    "embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy " +
    "enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry " +
    "envelope episode equal equip era erase erode erosion error erupt escape essay essence estate " +
    "eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude " +
    "excuse execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain " +
    "expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame " +
    "family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature " +
    "february federal fee feed feel female fence festival fetch fever few fiber fiction field " +
    "figure file film filter final find fine finger finish fire firm first fiscal fish fit " +
    "fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid " +
    "flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum " +
    "forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost " +
    "frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap " +
    "garage garbage garden garlic garment gas gasp gate gather gauge gaze general genius genre " +
    "gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad glance glare " +
    "glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla " +
    "gospel gossip govern gown grab grace grain grant grape grass gravity great green grid grief " +
    "grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half hammer " +
    "hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy " +
    "hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby " +
    "hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel " +
    "hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid " +
    "ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact " +
    "impose improve impulse inch include income increase index indicate indoor industry infant " +
    "inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry " +
    "insane insect inside inspire install intact interest into invest invite involve iron island " +
    "isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke " +
    "journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid " +
    "kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor " +
    "ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn lawsuit " +
    "layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length " +
    "lens leopard lesson letter level liar liberty library license life lift light like limb " +
    "limit link lion liquid list little live lizard load loan lobster local lock logic lonely " +
    "long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics " +
    "machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion " +
    "manual maple marble march margin marine market marriage mask mass master match material math " +
    "matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member " +
    "memory mention menu mercy merge merit merry mesh message metal method middle midnight milk " +
    "million mimic mind minimum minor minute miracle mirror misery miss mistake mix mixed mixture " +
    "mobile model modify mom moment monitor monkey monster month moon moral more morning mosquito " +
    "mother motion motor mountain mouse move movie much muffin mule multiply muscle museum " +
    "mushroom music must mutual myself mystery myth naive name napkin narrow nasty nation nature " +
    "near neck need negative neglect neither nephew nerve nest net network neutral never news " +
    "next nice night noble noise nominee noodle normal north nose notable note nothing notice " +
    "novel now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious " +
    "occur ocean october odor off offer office often oil okay old olive olympic omit once one " +
    "onion online only open opera opinion oppose option orange orbit orchard order ordinary organ " +
    "orient original orphan ostrich other outdoor outer output outside oval oven over own owner " +
    "oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade " +
    "parent park parrot party pass patch path patient patrol pattern pause pave payment peace " +
    "peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone " +
    "photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe " +
    "pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet " +
    "point polar pole police pond pony pool popular portion position possible post potato pottery " +
    "poverty powder power practice praise predict prefer prepare present pretty prevent price " +
    "pride primary print priority prison private prize problem process produce profit program " +
    "project promote proof property prosper protect proud provide public pudding pull pulp pulse " +
    "pumpkin punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality " +
    "quantum quarter question quick quit quiz quote rabbit raccoon race rack radar radio rail " +
    "rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real " +
    "reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse " +
    "region regret regular reject relax release relief rely remain remember remind remove render " +
    "renew rent reopen repair repeat replace report require rescue resemble resist resource " +
    "response result retire retreat return reunion reveal review reward rhythm rib ribbon rice " +
    "rich ride ridge rifle right rigid ring riot ripple risk ritual rival river road roast robot " +
    "robust rocket romance roof rookie room rose rotate rough round route royal rubber rude rug " +
    "rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same " +
    "sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme " +
    "school science scissors scorpion scout scrap screen script scrub sea search season seat " +
    "second secret section security seed seek segment select sell seminar senior sense sentence " +
    "series service session settle setup seven shadow shaft shallow share shed shell sheriff " +
    "shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug " +
    "shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since " +
    "sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep " +
    "slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack " +
    "snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve " +
    "someone song soon sorry sort soul sound soup source south space spare spatial spawn speak " +
    "special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon " +
    "sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs " +
    "stamp stand start state stay steak steel stem step stereo stick still sting stock stomach " +
    "stone stool story stove strategy street strike strong struggle student stuff stumble style " +
    "subject submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset " +
    "super supply supreme sure surface surge surprise surround survey suspect sustain swallow " +
    "swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup system table " +
    "tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten " +
    "tenant tennis tent term test text thank that theme then theory there they thing this thought " +
    "three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue " +
    "title toast tobacco today toddler toe together toilet token tomato tomorrow tone tongue " +
    "tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower " +
    "town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend " +
    "trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try " +
    "tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type " +
    "typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform " +
    "unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper " +
    "upset urban urge usage use used useful useless usual utility vacant vacuum vague valid " +
    "valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb " +
    "verify version very vessel veteran viable vibrant vicious victory video view village vintage " +
    "violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote " +
    "voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave " +
    "way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what " +
    "wheat wheel when where whip whisper wide width wife wild will win window wine wing wink " +
    "winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world " +
    "worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero " +
    "zone zoo "
  )
    .trim()
    .split(" "),
);

// Tokenizes on whitespace while preserving the exact separators, so we can scan
// for a contiguous run of valid lowercase BIP39 words and redact only that run
// (a bare mnemonic / seed phrase) without disturbing surrounding text.
const WHITESPACE_TOKEN_PATTERN = /(\s+)/u;

// Minimum BIP39 mnemonic length; a contiguous run of at least this many BIP39
// words is treated as a seed phrase.
const BIP39_MIN_MNEMONIC_LENGTH = 12;

// gaphunt3 #18: seed phrases are commonly copy/pasted comma-separated
// ("abandon, ability, ...") or as numbered lists ("1. abandon\n2. ability"),
// which fuses punctuation/digits to the whitespace-delimited tokens. A raw
// BIP39_WORDLIST.has(token) check fails for "abandon," / "1." and breaks the
// contiguous run, leaking the whole phrase. Classify each word token after
// stripping leading/trailing non-letters:
//   - "seed": its letter core is a BIP39 word (counts toward the run).
//   - "filler": no lowercase letters at all (pure punctuation/digits like
//     "2.", "-", "|", "•") — does NOT break the run and does NOT count.
//   - "other": a real non-seed word — breaks the run.
type Bip39TokenKind = "seed" | "filler" | "other";

function classifyBip39Token(token: string): Bip39TokenKind {
  // Case-insensitive: strip leading/trailing non-letters (either case) and
  // lowercase the core before the wordlist lookup, so Title-Case ("Abandon")
  // and ALL-CAPS ("ABANDON", the format on Ledger recovery sheets) seed words
  // are recognized. A run of 12+ consecutive wordlist words does not occur in
  // ordinary prose regardless of case, so this stays false-positive-safe.
  const core = token.replace(/^[^a-zA-Z]+/, "").replace(/[^a-zA-Z]+$/, "").toLowerCase();
  if (core.length > 0 && BIP39_WORDLIST.has(core)) return "seed";
  if (!/[a-zA-Z]/.test(token)) return "filler";
  return "other";
}

/**
 * Redacts a bare BIP39 mnemonic / seed phrase: a contiguous run of at least 12
 * lowercase words that are ALL members of the BIP39 wordlist. Requiring the full
 * wordlist (not a generic "N words" heuristic) keeps ordinary prose untouched,
 * since runs of a dozen-plus consecutive wordlist words do not occur in normal
 * text.
 *
 * The whole run is redacted whenever it reaches a mnemonic length, rather than
 * only when its length is EXACTLY canonical (12/15/18/21/24): a real seed phrase
 * frequently abuts ordinary prose, and hundreds of common English words ("gas",
 * "note", "year", "this", ...) are themselves BIP39 words, so the contiguous run
 * of wordlist words is often one or more words longer than a canonical mnemonic
 * length. Anchoring to an exact length would let a complete seed phrase leak
 * whenever a single wordlist word sits next to it; redacting the maximal run
 * guarantees no seed word survives regardless of where the extra words sit.
 */
function redactBareMnemonics(input: string): string {
  if (!/[a-zA-Z]/.test(input)) return input;
  const parts = input.split(WHITESPACE_TOKEN_PATTERN);
  // `parts` alternates word, separator, word, separator, ... so word tokens are
  // at even indices.
  let changed = false;
  let i = 0;
  while (i < parts.length) {
    if (i % 2 === 1) {
      i += 1;
      continue;
    }
    const word = parts[i];
    // gaphunt3 #18: a run only STARTS on a token whose letter core is a BIP39
    // word (punctuation-tolerant), so "abandon," / "1.abandon" anchor a run.
    if (word !== undefined && word.length > 0 && classifyBip39Token(word) === "seed") {
      // Extend the run over consecutive seed/filler words; "filler" tokens (pure
      // punctuation/digits like list numbers) bridge the run without counting.
      let end = i;
      let count = 0;
      // Index of the last seed token in the run, so trailing filler/separators
      // outside the actual phrase are not blanked.
      let lastSeedIdx = i;
      while (end < parts.length) {
        const candidate = parts[end];
        if (candidate === undefined) break;
        if (end % 2 === 0) {
          if (candidate.length === 0) break;
          const kind = classifyBip39Token(candidate);
          if (kind === "other") break;
          if (kind === "seed") {
            count += 1;
            lastSeedIdx = end;
          }
        }
        end += 1;
      }
      if (count >= BIP39_MIN_MNEMONIC_LENGTH) {
        for (let j = i; j <= lastSeedIdx; j += 1) parts[j] = "";
        parts[i] = REDACTED_SECRET;
        changed = true;
        i = lastSeedIdx + 1;
        continue;
      }
      i = lastSeedIdx + 1;
      continue;
    }
    i += 1;
  }
  return changed ? parts.join("") : input;
}

/**
 * Integer-list classification policy (wallet byte arrays vs analytical data).
 *
 * Solana / ed25519 secret keys are commonly exported as a bracketed list of
 * comma-separated bytes: the standard `~/.config/solana/id.json` file is a
 * 64-element list (32-byte secret scalar followed by the 32-byte public key),
 * and the bare secret scalar is a 32-element list. Nothing about the numeric
 * syntax distinguishes such a list from ordinary analytical output: an index
 * permutation, a histogram, a byte dump of a file, or a table of small counts
 * printed by a tool has exactly the same shape. An earlier rule redacted every
 * textual list of 32–200 bytes and claimed that this excluded ordinary numeric
 * arrays; it did not, and it erased benign 80/100-element permutations from
 * durable tool history (#2476). The ambiguity is unavoidable, so the policy
 * below is explicit about what decides:
 *
 *  1. Supported key formats. Only the two raw ed25519 encodings exist as a
 *     bare byte list: exactly 32 elements (secret scalar) or exactly 64
 *     elements (keypair). A list of any other length is not a supported
 *     raw-key encoding and is preserved byte-for-byte. Length is therefore a
 *     *negative* test only (it proves a list is not a key); it never proves a
 *     list is one.
 *  2. Missing context (fail closed). A list of exactly 32 or 64 unsigned bytes
 *     is ambiguous: a benign 32-index permutation and a secret scalar are the
 *     same text. With no trusted signal either way the list is redacted, since
 *     a leaked key is unrecoverable while a lost 32/64-element analytical
 *     list is a bounded evidence loss. Nothing in the surrounding text can
 *     lift this: labels such as `permutation =` or `T[:64]` are untrusted tool
 *     output, so a cosmetic label cannot grant a real key an exemption.
 *  3. Sensitive-field / key-file context (widen only). A list of integers of
 *     any length whose immediate label is a sensitive key name
 *     (`"secretKey": [...]`, `private_key = [...]`, mirrors `isSensitiveKey`)
 *     is redacted regardless of length or value range, matching the structured
 *     leaf rule where any value under a sensitive key is redacted. In-band
 *     context can only widen redaction, never narrow it.
 *  4. Trusted provenance. The only trusted provenance the sanitizer has is
 *     structural: in `redactSecretsInValue` a numeric JSON array is typed data
 *     produced by the runtime, not pasted text, so it is preserved under an
 *     ordinary key and leaf-redacted under a sensitive key. That decision is
 *     made from the JSON position, never from the string content, so a tool
 *     cannot reach it by formatting its stdout.
 *
 * Signed-byte dumps (`[-12, 34, ...]`), fractional values and values above
 * 255 are never treated as key material by rules 1–2 (they are not the raw
 * ed25519 encodings); rule 3 still redacts them under a sensitive label.
 *
 * Already-persisted `[REDACTED_SECRET]` markers written by the earlier rule are
 * not recoverable: the durable record holds a digest of the original body,
 * not the body. This module never rewrites history or synthesizes values.
 */
const AMBIGUOUS_RAW_KEY_LENGTHS: ReadonlySet<number> = new Set([32, 64]);
const MAX_AMBIGUOUS_RAW_KEY_LENGTH = Math.max(...AMBIGUOUS_RAW_KEY_LENGTHS);
const MAX_INTEGER_LIST_LABEL_LENGTH = 128;
const MAX_UNSIGNED_BYTE = 255;

type IntegerListClassification =
  | "benign_length"
  | "ambiguous_raw_key_length"
  | "sensitive_label";

interface ParsedIntegerList {
  /** Index just past the closing bracket. */
  readonly end: number;
  readonly count: number;
  readonly allUnsignedBytes: boolean;
}

function classifyIntegerList(
  list: ParsedIntegerList,
  hasSensitiveLabel: boolean,
): IntegerListClassification {
  if (hasSensitiveLabel) return "sensitive_label";
  if (list.allUnsignedBytes && AMBIGUOUS_RAW_KEY_LENGTHS.has(list.count)) {
    return "ambiguous_raw_key_length";
  }
  return "benign_length";
}

function shouldRedactIntegerList(
  classification: IntegerListClassification,
): boolean {
  switch (classification) {
    case "sensitive_label":
    case "ambiguous_raw_key_length":
      return true;
    case "benign_length":
      return false;
    default: {
      const exhaustive: never = classification;
      throw new Error(`unhandled integer-list classification: ${String(exhaustive)}`);
    }
  }
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isWhitespaceCode(code: number): boolean {
  // Must recognise exactly what an ECMAScript /\s/u class matches (WhiteSpace +
  // LineTerminator). The bracket scanner is hand-rolled for bounded cost, but an
  // ASCII-only notion of "separator" lets a byte list formatted with NBSP or EM
  // SPACE parse as something other than 32/64 elements, so a real key survives
  // redaction unchanged. Length stays a negative test and the 32/64 fail-closed
  // policy is untouched; this only restores the separator coverage the previous
  // \s-based rule already had (#2476).
  return (
    code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d ||
    code === 0x0b || code === 0x0c ||
    code === 0xa0 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 ||
    code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff
  );
}

function isIdentifierCode(code: number): boolean {
  return (
    isAsciiDigit(code) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f || // _
    code === 0x2d // -
  );
}

/**
 * Parses a flat list of optionally-negative decimal integers starting at the
 * `[` at `open`. Returns null when the bracket does not open such a list
 * (nested brackets, fractions, identifiers, trailing commas) or when the list
 * exceeds `maxCount` elements, which lets callers stop scanning a long benign
 * list as soon as it can no longer match a redactable shape.
 */
function parseIntegerList(
  input: string,
  open: number,
  maxCount: number,
): ParsedIntegerList | null {
  const length = input.length;
  let i = open + 1;
  let count = 0;
  let allUnsignedBytes = true;
  const skipWhitespace = (): void => {
    while (i < length && isWhitespaceCode(input.charCodeAt(i))) i += 1;
  };
  skipWhitespace();
  while (i < length) {
    let negative = false;
    if (input.charCodeAt(i) === 0x2d) {
      negative = true;
      i += 1;
    }
    const digitsStart = i;
    while (i < length && isAsciiDigit(input.charCodeAt(i))) i += 1;
    const digitCount = i - digitsStart;
    if (digitCount === 0) return null;
    count += 1;
    if (count > maxCount) return null;
    if (allUnsignedBytes) {
      allUnsignedBytes =
        !negative &&
        digitCount <= 3 &&
        Number(input.slice(digitsStart, i)) <= MAX_UNSIGNED_BYTE;
    }
    skipWhitespace();
    if (i >= length) return null;
    const code = input.charCodeAt(i);
    if (code === 0x5d) return { end: i + 1, count, allUnsignedBytes };
    if (code !== 0x2c) return null;
    i += 1;
    skipWhitespace();
    // A trailing comma is tolerated so that `[..., 12,]` cannot dodge the
    // 32/64 rule while still reading as the same list.
    if (i < length && input.charCodeAt(i) === 0x5d) {
      return { end: i + 1, count, allUnsignedBytes };
    }
  }
  return null;
}

/**
 * True when the `[` at `open` is immediately labelled by a sensitive key name
 * (`secretKey: [`, `"private_key": [`, `SEED_PHRASE = [`). Only the identifier
 * directly bound to the list by `:` or `=` counts; prose or other tokens
 * between the name and the bracket do not. Labels widen redaction only, so an
 * untrusted producer gains nothing by choosing one.
 */
function hasSensitiveLabelBefore(input: string, open: number): boolean {
  let i = open - 1;
  while (i >= 0 && isWhitespaceCode(input.charCodeAt(i))) i -= 1;
  if (i < 0) return false;
  const separator = input.charCodeAt(i);
  if (separator !== 0x3a && separator !== 0x3d) return false; // : or =
  i -= 1;
  while (i >= 0 && isWhitespaceCode(input.charCodeAt(i))) i -= 1;
  if (i < 0) return false;
  let quote = 0;
  const maybeQuote = input.charCodeAt(i);
  if (maybeQuote === 0x22 || maybeQuote === 0x27) {
    quote = maybeQuote;
    i -= 1;
  }
  const labelEnd = i + 1;
  const labelFloor = Math.max(-1, labelEnd - 1 - MAX_INTEGER_LIST_LABEL_LENGTH);
  while (i > labelFloor && isIdentifierCode(input.charCodeAt(i))) i -= 1;
  const labelStart = i + 1;
  if (labelStart === labelEnd) return false;
  if (quote !== 0 && (i < 0 || input.charCodeAt(i) !== quote)) return false;
  return isSensitiveKey(input.slice(labelStart, labelEnd));
}

/**
 * Applies the integer-list policy documented above to every bracketed list
 * in `input`. Single linear pass: each `[` is parsed at most once and parsing
 * stops as soon as an unlabelled list is longer than any redactable shape.
 */
function redactIntegerListKeyMaterial(input: string): string {
  let open = input.indexOf("[");
  if (open === -1) return input;
  let output = "";
  let copiedUpTo = 0;
  while (open !== -1) {
    const sensitiveLabel = hasSensitiveLabelBefore(input, open);
    const parsed = parseIntegerList(
      input,
      open,
      sensitiveLabel ? Number.POSITIVE_INFINITY : MAX_AMBIGUOUS_RAW_KEY_LENGTH,
    );
    if (
      parsed !== null &&
      shouldRedactIntegerList(classifyIntegerList(parsed, sensitiveLabel))
    ) {
      output += input.slice(copiedUpTo, open) + REDACTED_SECRET;
      copiedUpTo = parsed.end;
      open = input.indexOf("[", parsed.end);
      continue;
    }
    open = input.indexOf("[", open + 1);
  }
  if (copiedUpTo === 0) return input;
  return output + input.slice(copiedUpTo);
}

const SECRET_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replacement: string;
}> = [
  {
    // QwenCloud workspace / Token Plan keys use three dot-separated payload
    // segments. The generic sk-* matcher intentionally excludes dots, so the
    // complete vendor shape must run first or only its short prefix is seen.
    pattern:
      /(?<![A-Za-z0-9_.-])sk-(?:ws|sp)-H\.[A-Za-z0-9_-]{4,32}\.[A-Za-z0-9_-]{4,32}\.[A-Za-z0-9_-]{32,}(?=$|[^A-Za-z0-9_.-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    // xAI — the runtime's OWN classifier key shape; redact first so a bare
    // `xai-...` never leaks even when no surrounding key/context is present.
    pattern: /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9_-]{16,}(?=$|[^A-Za-z0-9_-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    // Also matches `sk-ant-…` (the `ant-` chars are in the class), so no separate
    // sk-ant entry is needed — the generic pattern runs first and shadows it.
    pattern: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?=$|[^A-Za-z0-9_-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    pattern: /(?<![A-Za-z0-9_-])gsk_[A-Za-z0-9_-]{20,}(?=$|[^A-Za-z0-9_-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    pattern: /(?<![A-Za-z0-9_])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}(?=$|[^A-Za-z0-9_])/g,
    replacement: REDACTED_SECRET,
  },
  {
    pattern: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}(?=$|[^A-Za-z0-9_])/g,
    replacement: REDACTED_SECRET,
  },
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED_SECRET,
  },
  {
    // Slack tokens (bot/app/user/refresh/configuration).
    pattern: /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}(?=$|[^A-Za-z0-9-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    // Google API keys: fixed `AIza` prefix + 35 chars is specific enough on its own.
    pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?=$|[^A-Za-z0-9_-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    // AWS secret access keys are 40-char base64 with no distinctive prefix, so a
    // bare 40-char token is too noisy to redact. Scope to an explicit
    // aws/secret/access-key context word immediately preceding the value to keep
    // false positives off ordinary prose. The separator tolerates a closing
    // quote before the colon so JSON-quoted keys (`"aws_secret_access_key":`) are
    // covered, and the value tolerates trailing `=` base64 padding.
    pattern:
      /\b(aws[_-]?secret[_-]?access[_-]?key|aws[_-]?secret|secret[_-]?access[_-]?key)\b(["']?\s*[:=]\s*|\s+)(["']?)[A-Za-z0-9/+]{40}={0,2}(?![A-Za-z0-9/+=])/gi,
    replacement: `$1$2$3${REDACTED_SECRET}`,
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}(?=$|[^A-Za-z0-9._~+/=-])/gi,
    replacement: `Bearer ${REDACTED_SECRET}`,
  },
  {
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?=$|[^A-Za-z0-9_-])/g,
    replacement: REDACTED_SECRET,
  },
  {
    // Solana / ed25519 secret keys exported as base58 are an unbroken run of
    // ~87-88 base58 chars (no 0, O, I, l). Public keys are only ~32-44 chars,
    // so a long base58 run is a strong wallet-secret signal on its own. The
    // boundaries reject runs that are part of a longer identifier.
    pattern: /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{80,90}(?![1-9A-HJ-NP-Za-km-z])/g,
    replacement: REDACTED_SECRET,
  },
  // Bracketed integer lists (Solana `id.json`-style byte arrays) are not a
  // regex entry: their classification needs the exact element count and the
  // surrounding label, so `redactIntegerListKeyMaterial` handles them below.
  {
    // PEM private-key blocks (PKCS#1/PKCS#8/EC/OpenSSH/encrypted). Redact the
    // whole armored block including the base64 body rather than leaking it as a
    // bare string when a keyfile is read/cat'd into logs or artifacts.
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
    replacement: REDACTED_SECRET,
  },
  {
    pattern:
      /(["'])(api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|passphrase|authorization|private[_-]?key|signing[_-]?key|mnemonic|seed[_-]?phrase)\1(\s*:\s*)(["']?)[^\s"',}]{8,}/gi,
    replacement: `$1$2$1$3$4${REDACTED_SECRET}`,
  },
  {
    pattern:
      /\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|passphrase|authorization|private[_-]?key|signing[_-]?key|mnemonic|seed[_-]?phrase)\b(\s*[:=]\s*)(["']?)[^\s"',}]{8,}/gi,
    replacement: `$1$2$3${REDACTED_SECRET}`,
  },
];

const QUOTED_SECRET_ASSIGNMENT_PATTERN =
  /(["'])([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passphrase|authorization|private[_-]?key|signing[_-]?key|mnemonic|seed[_-]?phrase)[A-Za-z0-9_-]*)\1(\s*:\s*)(["']?)[^\s"',}]{8,}/gi;

const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passphrase|authorization|private[_-]?key|signing[_-]?key|mnemonic|seed[_-]?phrase)[A-Za-z0-9_-]*)\b(\s*[:=]\s*)(["']?)[^\s"',}]{8,}/gi;

export type RedactableJson =
  | null
  | boolean
  | number
  | string
  | RedactableJson[]
  | { readonly [key: string]: RedactableJson };

/** Redacts common API keys, access tokens, bearer tokens, JWTs, and secret assignments. */
export function redactSecrets(input: string): string {
  let redacted = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  redacted = redactIntegerListKeyMaterial(redacted);
  redacted = redacted.replace(
    QUOTED_SECRET_ASSIGNMENT_PATTERN,
    (match, quote: string, key: string, separator: string, valueQuote: string) =>
      isSensitiveKey(key)
        ? `${quote}${key}${quote}${separator}${valueQuote}${REDACTED_SECRET}`
        : match,
  );
  redacted = redacted.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (match, key: string, separator: string, valueQuote: string) =>
      isSensitiveKey(key)
        ? `${key}${separator}${valueQuote}${REDACTED_SECRET}`
        : match,
  );
  redacted = redactBareMnemonics(redacted);
  return redacted;
}

/** Redacts strings inside JSON-like artifacts without mutating the original value. */
export function redactSecretsInValue<T>(value: T): T {
  return redactValue(value, new WeakMap<object, unknown>()) as T;
}


function redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) {
      output.push(redactValue(item, seen));
    }
    return output;
  }

  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key) && nested !== null && nested !== undefined) {
      output[key] = REDACTED_SECRET;
      continue;
    }
    output[key] = redactValue(nested, seen);
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return (
    normalized === "apikey" ||
    normalized.endsWith("apikey") ||
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized.endsWith("tokenvalue") ||
    normalized === "secret" ||
    normalized.endsWith("secret") ||
    normalized.endsWith("secretvalue") ||
    // AWS access keys normalize to `...accesskey`/`...secretkey`, matching neither
    // `apikey` nor `secret`; recognize their specific shapes without making every
    // `...key` sensitive.
    normalized.endsWith("secretaccesskey") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("accesskeyid") ||
    normalized === "password" ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwordvalue") ||
    // Vault/wallet passphrase (e.g. AGENC_WALLET_VAULT_PASSPHRASE). A passphrase
    // is always a scalar secret, so leaf-redacting it here is safe. `credential`
    // is deliberately NOT leaf-redacted: it is frequently a container object
    // (e.g. an AWS credentials block) whose inner fields must be redacted
    // individually — it is handled by the scalar string-assignment patterns.
    normalized.endsWith("passphrase") ||
    normalized.includes("authorization") ||
    // Wallet key material: private/signing keys, mnemonics, and seed phrases
    // (snake_case + camelCase both normalize to these). `seedphrase` is matched
    // rather than a bare `seed` to avoid redacting unrelated `seed`/`randomSeed`
    // counters.
    normalized.endsWith("privatekey") ||
    normalized.endsWith("signingkey") ||
    normalized === "mnemonic" ||
    normalized.endsWith("mnemonic") ||
    normalized.endsWith("seedphrase") ||
    normalized.endsWith("keypaircontents")
  );
}
