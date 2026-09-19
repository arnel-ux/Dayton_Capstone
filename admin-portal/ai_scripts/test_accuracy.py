"""
Accuracy regression harness for the sentiment + topic pipeline.

Each case is (comment_text, expected_sentiment, expected_topic). The suite
deliberately covers two buckets:
  - "lexicon-hit" cases: text that topic_common's keyword lexicons (either
    TOPIC_KEYWORDS/TOPIC_ITEM_KEYWORDS for topic, or FAST_POSITIVE_WORDS/
    FAST_NEGATIVE_WORDS/FAST_NEUTRAL_PHRASES for sentiment) resolve outright.
    These act as a sanity baseline for the whole pipeline and should stay
    ~100% regardless of any transformer-side change.
  - "lexicon-miss" cases: text engineered to have ZERO keyword coverage in
    either lexicon, so heavy_model.analyze() must fall through to the
    transformer models (mDeBERTa zero-shot for topic, tabularisai for
    sentiment). This is the subset that actually exercises — and measures —
    the AI fallback quality the rest of the project cares about.

Which bucket a given case falls into is not hand-labeled; it's detected at
run time by calling topic_common.lexicon_sentiment / keyword_topic_override
directly on the case text, so the classification always matches the current
state of the lexicons even if they change later.

Run: python test_accuracy.py
"""
import sys
import time

import topic_common as tc
import heavy_model as hm

# Each tuple: (text, expected_sentiment, expected_topic, office_hint)
# office_hint is None unless a case specifically wants to test the soft
# office-aware nudge.
CASES = [
    # =========================================================================
    # LEXICON-HIT cases (sanity baseline) — deliberately contain a keyword
    # anchor from TOPIC_KEYWORDS/TOPIC_ITEM_KEYWORDS and/or
    # FAST_POSITIVE_WORDS/FAST_NEGATIVE_WORDS so both lexicons resolve them.
    # =========================================================================
    ("Ang bagal ng pila, sobrang tagal ko naghintay.", "Negative", "Queueing and Waiting Time - Long Lines", None),
    ("Mabilis lang ang pila ngayon, maganda ang numbering system.", "Positive", "Queueing and Waiting Time - Numbering System", None),
    ("Walang internet dito, hirap kami mag-online.", "Negative", "Internet Connection - Signal", None),
    ("Maayos naman ang wifi ngayon, stable ang koneksyon.", "Positive", "Internet Connection - Wifi", None),
    ("Nakakalito ang online system, hindi ko alam saan mag-login.", "Negative", "Online System and Portal - Login/Account", None),
    ("Madaling gamitin ang portal, user-friendly talaga.", "Positive", "Ease of Use - User-Friendly Design", None),
    ("Sira ang aircon sa opisina, sobrang init.", "Negative", "Aircon and Cooling - Air Conditioning Unit", None),
    # Deliberate taxonomy change (2026-09): a cleanliness word ("malinis"/
    # "marumi") + a bare restroom-location word now resolves to "Cleanliness
    # - Restroom/CR", not the plain "Restroom" topic — the ISSUE is
    # cleanliness, the restroom is only the location/subtopic. Previously
    # this and "Restroom" both scored 1 hit and "Restroom" won purely
    # because it's listed earlier in TOPIC_KEYWORDS; cleanliness/appearance
    # descriptors are now weighted 1.5 in that dict specifically so the
    # issue word outranks the bare location noun on a tie (see topic_common
    # Cleanliness comment). "Restroom" the topic is still correct for a
    # restroom complaint that ISN'T about cleanliness (e.g. "walang tissue",
    # "sira ang gripo sa CR").
    ("Malinis ang comfort room ngayon, salamat.", "Positive", "Cleanliness - Restroom/CR", None),
    ("Marumi ang banyo, nakakadiri.", "Negative", "Cleanliness - Restroom/CR", None),
    ("Sirang silya ang nakita ko sa waiting area.", "Negative", "Seating and Furniture - Chairs", None),
    ("Walang kuryente kanina, nag-brownout ng ilang oras.", "Negative", "Power and Lighting - Power Outage", None),
    ("Bastos ang guard sa gate, hindi magalang.", "Negative", "Courtesy and Attitude - Security Guard", None),
    ("Mabait at magalang ang staff sa counter, salamat po.", "Positive", "Courtesy and Attitude - Staff/Employee", None),
    ("Hindi marunong sumagot yung clerk sa tanong ko.", "Negative", "Staff Competence and Knowledge - Knowledge/Answer Accuracy", None),
    ("Walang palakasan dito, pantay-pantay lahat ng estudyante.", "Positive", "Fairness and Equal Treatment - Favoritism", None),
    ("Sobrang mahal ng bayad para sa TOR.", "Negative", "Payment and Fees - Fees", None),
    ("Mabilis ang pag-release ng resulta, hassle-free.", "Positive", "Transaction - Fast", None),
    ("Maraming hakbang bago matapos ang proseso, kumplikado.", "Negative", "Process Efficiency - Complexity/Red Tape", None),
    ("Isang beses lang pumunta, tapos na agad, one-stop shop talaga.", "Positive", "Process Efficiency - Simplicity", None),
    ("Walang paalam sa akin tungkol sa schedule ng enrollment.", "Negative", "Enrollment and Registration - Enrollment/Registration Process", None),
    ("Mabilis ang response ng doktor sa clinic, maayos ang check-up.", "Positive", "Health and Medical Services - Consultation/Check-up", None),
    ("Matagal ang proseso ng scholarship application ko.", "Negative", "Scholarship and Financial Assistance - Scholarship Application/Grant", None),
    ("Nakatulong ang guidance counselor sa problema ko.", "Negative", "Guidance and Counseling Services", None),
    ("Walang libro sa library na hinahanap ko, kulang ang stock.", "Negative", "Facilities and Equipment - Library", None),
    ("Maayos ang matriculation process ngayong semester.", "Positive", "Enrollment and Registration - Matriculation", None),
    ("The queue was so slow and the line never moved.", "Negative", "Queueing and Waiting Time - Long Lines", None),
    ("The staff was very rude and unprofessional at the counter.", "Negative", "Courtesy and Attitude - Staff/Employee", None),
    ("Great and friendly service, the receptionist was very helpful.", "Positive", "Courtesy and Attitude - Front Desk/Clerk", None),
    ("The website is confusing and hard to use.", "Negative", "Online System and Portal - Website", None),
    ("Fast transaction, excellent process overall.", "Positive", "Transaction - Fast", None),
    ("The aircon was broken, it was too hot inside.", "Negative", "Aircon and Cooling - Air Conditioning Unit", None),
    ("No wifi in the building, very frustrating.", "Negative", "Internet Connection - Wifi", None),
    ("Good moral certificate ko medyo natagalan pero nakuha rin.", "Neutral", "Document and Credential Processing - Good Moral Certificate", None),
    ("Ang mahal ng parking fee dito.", "Negative", "Payment and Fees - Fees", None),
    ("Nasira yung printer sa computer lab, hindi na gumagana.", "Negative", "Facilities and Equipment - Equipment/Machine", None),

    # =========================================================================
    # LEXICON-MISS cases — English (no TOPIC_KEYWORDS / FAST_*_WORDS overlap).
    # Nuanced, indirect, sarcastic, mixed, vague, or run-on phrasing that
    # exercises the transformer fallback path.
    # =========================================================================
    ("I walked in, sat down, and honestly I don't even remember what happened after that, everything just kind of blurred together in the most forgettable way possible.", "Neutral", "General Feedback", None),
    ("Oh sure, because nothing says efficient like standing around wondering if anyone actually works here.", "Positive", "Process Efficiency", None),
    ("It started out rough but by the end everything turned around and I left feeling pretty good about the whole visit.", "Positive", "General Feedback", None),
    ("I have genuinely no strong feelings about my visit, it was neither impressive nor disappointing, just an ordinary Tuesday errand.", "Negative", "General Feedback", None),
    ("Some parts of my experience were wonderful and some parts made me want to scream, so I really can't give a simple verdict.", "Neutral", "General Feedback", None),
    ("Wow, what a masterclass in making a simple errand feel like an obstacle course designed by someone who hates students.", "Negative", "Process Efficiency - Complexity/Red Tape", None),
    ("They really outdid themselves this time, and not in a good way, if you know what I mean.", "Negative", "General Feedback", None),
    ("Everyone kept passing me from one window to another and by the third redirect I just gave up trying to keep count.", "Negative", "Process Efficiency - Complexity/Red Tape", None),
    ("I can't complain, I also can't say it blew me away, it just sort of happened and I moved on with my day.", "Neutral", "General Feedback", None),
    ("Honestly the whole thing felt like a rollercoaster, up one minute, down the next, impossible to pin down.", "Neutral", "General Feedback", None),
    ("The person who assisted me clearly knew what they were doing and it showed in how quickly everything came together.", "Positive", "Staff Competence and Knowledge", None),
    ("Nobody seemed to know what was going on, and every answer I got contradicted the last one.", "Negative", "Staff Competence and Knowledge", None),
    ("It's the kind of place where you brace yourself for disappointment and somehow it still manages to fall short of that.", "Negative", "General Feedback", None),
    ("I walked away impressed, honestly did not expect that level of care from a campus office.", "Positive", "General Feedback", None),
    ("There's nothing particularly wrong with it, but there's nothing that stands out either, it just exists.", "Neutral", "General Feedback", None),
    ("The whole ordeal left me questioning my life choices, truly a special kind of chaos.", "Negative", "Process Efficiency", None),
    ("A pleasant surprise from start to finish, I genuinely didn't think it would go this smoothly.", "Positive", "Process Efficiency", None),
    ("They treated me like I was invisible the entire time I was standing right in front of them.", "Negative", "Courtesy and Attitude", None),
    ("It wasn't the best, it wasn't the worst, somewhere comfortably in the middle of forgettable.", "Neutral", "General Feedback", None),
    # Item updated 2026-08-31 after adding the Staff/Employee item — Gemini
    # correctly infers "the lady who helped me" is staff from context even
    # though the word "staff" never appears, matching the new subtopic
    # granularity instead of stopping at the plain topic.
    ("The lady who helped me deserves a raise, she went out of her way to make sure I understood everything.", "Positive", "Courtesy and Attitude - Staff/Employee", None),
    ("I appreciated how thoroughly everything was explained, made a confusing situation feel manageable.", "Neutral", "Communication and Information", None),
    ("Half the time I couldn't tell if anyone was actually listening to what I was asking.", "Negative", "Communication and Information", None),
    ("What a triumph of bureaucracy over basic human decency.", "Negative", "General Feedback", None),
    ("I've genuinely had worse days at the dentist, so that's saying something about how this went.", "Negative", "Health and Medical Services - Dental Services", None),
    ("The counselor really took the time to understand where I was coming from before offering any advice.", "Positive", "Guidance and Counseling Services", None),
    ("They just kept telling me to come back another day without ever explaining why.", "Negative", "Communication and Information", None),
    ("I'm still not entirely sure what just happened, but I don't think it was good.", "Positive", "General Feedback", None),
    ("Everything about the visit felt rushed, like they wanted me gone as fast as possible.", "Positive", "Process Efficiency", None),
    ("The scholarship advisor walked me through every requirement patiently, no complaints there.", "Positive", "Scholarship and Financial Assistance - Scholarship Application/Grant", None),
    ("It's hard to put into words how underwhelming the whole thing turned out to be.", "Negative", "General Feedback", None),
    ("I'd call it a mixed bag, some staff were lovely, others clearly did not want to be there.", "Neutral", "Courtesy and Attitude - Staff/Employee", None),
    ("The whole building felt like it was falling apart around us, quite unsettling honestly.", "Negative", "Facilities and Equipment - Building/Structure", None),
    ("They handled my documents with more care than I expected, everything came back correct.", "Positive", "Document and Credential Processing", None),
    ("Honestly I went in expecting the worst and came out pleasantly surprised by how organized it all was.", "Negative", "Process Efficiency - Simplicity", None),
    ("The registration desk felt like navigating a maze blindfolded.", "Negative", "Enrollment and Registration - Enrollment/Registration Process", None),

    # =========================================================================
    # LEXICON-MISS cases — Tagalog (no TOPIC_KEYWORDS / FAST_*_WORDS overlap;
    # avoid every anchor noun/phrase above, use indirect/idiomatic phrasing).
    # =========================================================================
    # Reworded 2026-08-31 — the original phrasing ("...habang naghihintay...")
    # accidentally contained the "naghihintay" lexicon anchor (pre-existing,
    # unrelated to any of that day's taxonomy changes), so this was silently
    # a lexicon-hit case mislabeled as a lexicon-miss one. Reworded to
    # preserve the same implied-waiting meaning without the anchor word, so
    # it actually exercises the AI fallback path as originally intended.
    ("Parang nasa ibang mundo ako, ang haba ng oras na lumipas bago ako naasikaso.", "Negative", "Queueing and Waiting Time", None),
    ("Bumalik ako ng ilang beses dahil laging kulang yung requirements na sinasabi nila, iba-iba sagot kada tanong.", "Negative", "Communication and Information - Inconsistent/Contradicting Information", None),
    ("Sa totoo lang di ko masabing masama, pero di rin naman siya kahanga-hanga, ganon lang siya.", "Positive", "General Feedback", None),
    # Reworded 2026-09 — "nag-asikaso" collided with the new Courtesy and
    # Attitude "Accommodation/Assistance" item keywords added for the
    # lexicon-accuracy pass (see topic_common.py), same "anchor word added
    # later, reword to keep exercising the AI fallback" pattern as the
    # "naasikaso" case above.
    ("Grabe yung pasensya ng taong kausap ko, kahit paulit-ulit kong tinatanong, buong-buo pa rin sinasagot niya.", "Negative", "Courtesy and Attitude", None),
    ("Parang wala silang paki kung anong oras ka dumating, ganon pa rin bilis ng galaw nila.", "Negative", "Process Efficiency", None),
    ("Kung babalikan ko yung karanasan, sasabihin kong okay lang siya, walang espesyal pero tapos naman.", "Neutral", "General Feedback", None),
    ("Ang galing nila ipaliwanag yung bawat hakbang, kahit unang beses ko lang gawin naintindihan ko agad.", "Positive", "Communication and Information", None),
    ("Grabe, akala mo simple lang yung kailangan kong gawin pero umabot pa ako ng tatlong beses bumalik.", "Negative", "General Feedback", None),
    ("Hindi ko alam kung dapat ba akong magalit o magpasalamat, magkahalo yung nangyari sa akin.", "Neutral", "General Feedback", None),
    # Reworded 2026-08-31 — same "naghintay" anchor collision as above, same
    # fix. Reworded again 2026-09 to also avoid "na-asikaso" (see the
    # Courtesy and Attitude comment above).
    ("Kahit medyo maraming tao, hindi naman ako natagalan, bigla na lang may lumapit sa akin.", "Negative", "General Feedback", None),
    ("Yung kausap ko parang gustong-gusto na akong umalis, halatang ayaw makipag-usap.", "Negative", "Courtesy and Attitude", None),
    ("Nagulat ako sa bilis, akala ko matatagalan pa ako pero bago pa man ako maupo tapos na agad.", "Positive", "Transaction - Fast", None),
    ("Sa dami ng beses kong pumunta, wala pa rin akong maayos na sagot kung ano talaga ang kailangan ko.", "Positive", "Communication and Information", None),
    ("Kung tutuusin, di ko naramdaman kahit anong pagbabago mula noong huli akong pumunta rito.", "Neutral", "General Feedback", None),
    ("Sobrang lambing at pasensya ng nurse habang tinuturuan niya ako kung paano gagawin yung sunod na hakbang.", "Positive", "Health and Medical Services - Consultation/Check-up", None),
    ("Yung binisita ko para sa tulong pinansyal, ang bagal umapruba, ilang buwan bago dumating yung kasagutan.", "Neutral", "Scholarship and Financial Assistance - Financial Assistance/Grants-in-Aid", None),
    ("Yung guro naman kong kinausap talagang inintindi yung sitwasyon ko bago nagbigay ng payo.", "Positive", "Courtesy and Attitude - Faculty/Adviser", None),
    ("Halatang bagong-bago pa lang siya sa trabaho, kita mo sa mata niya na naguguluhan din siya sa sarili niyang ginagawa.", "Negative", "Staff Competence and Knowledge", None),
    ("Wala akong masabi kundi papuri, dahil kahit pila ay wala, deretso na ako naasikaso.", "Positive", "Queueing and Waiting Time - Long Lines", None),
    ("Parang gusto ko nang sumuko dahil bawat opisina pinupunta ko iba't ibang bagay pa ang hinihingi.", "Negative", "Document and Credential Processing", None),
    ("Hindi ko masabi kung dahil ba sa dami ng estudyante o ano, pero mas mabagal ang lahat kesa dati.", "Negative", "Process Efficiency", None),
    ("Salamat sa pang-unawa nila kahit medyo nahuli ako sa oras ng pagpunta.", "Positive", "Courtesy and Attitude", None),
    ("Sa dulo ng araw, nasagot din naman lahat ng katanungan ko kahit umikot-ikot muna ako.", "Neutral", "General Feedback", None),
    # Item updated 2026-08-31 — this comment is about STAFF treating every
    # incoming student as a burden, not students' own attitude. Confirms the
    # design choice to keep "estudyante" out of TOPIC_KEYWORDS/item-resolving
    # keywords for the object role (see Courtesy and Attitude's keyword
    # comment in topic_common.py): Gemini correctly reads the subject as
    # staff from context, which a naive "estudyante appears -> Student item"
    # keyword rule would have gotten backwards.
    ("Bawat pumapasok na estudyante parang nakikita nilang pabigat, halata sa mukha nila.", "Negative", "Courtesy and Attitude - Staff/Employee", None),

    # =========================================================================
    # LEXICON-MISS cases — Taglish (mixed register, still no lexicon overlap).
    # =========================================================================
    ("Grabe ang experience ko, parang I was talking to a wall, walang gumagalaw kahit ilang beses ko na-request.", "Negative", "Communication and Information", None),
    ("Not gonna lie, medyo nag-alala ako pero turns out okay lang naman pala lahat, walang big deal.", "Neutral", "General Feedback", None),
    ("Actually surprised ako kasi expecting ako ng drama pero ang bait pala nila, super patient sa mga katanungan ko.", "Positive", "Courtesy and Attitude", None),
    ("Parang sobrang lost ako the whole time, walang nag-guide sa akin kung saan dapat pumunta.", "Negative", "Communication and Information", None),
    ("Honestly parang roller coaster yung buong araw ko dito, minsan ok minsan hindi, hard to describe.", "Neutral", "General Feedback", None),
    ("Sobrang thankful ako kasi even though marami akong tanong, hindi sila nagsawa magpaliwanag paulit-ulit.", "Negative", "Communication and Information", None),
    ("Feeling ko parang naglalaro lang sila ng passing the buck, walang gustong mag-take responsibility.", "Negative", "Process Efficiency", None),
    ("Di ko rin masabi kung dapat ba akong ma-frustrate, medyo mixed pa rin yung take ko sa buong bagay.", "Neutral", "General Feedback", None),
    ("Grabe sobrang bilis, akala ko matatagalan pa ako pero deretso lang pala, super efficient talaga sila.", "Positive", "Transaction - Fast", None),
    ("Parang wala silang plano, sunud-sunod na miscommunication ang nangyari sa akin buong araw.", "Negative", "Communication and Information", None),
    ("Yung nag-assist samin sobrang the sweetest, kahit pagod na siya pinilit pa rin niyang tapusin lahat.", "Positive", "Courtesy and Attitude", None),
    ("Kind of a letdown honestly, expecting ako ng mas maayos given lahat ng sinabi nila before.", "Positive", "General Feedback", None),
    ("Di ko alam paano isasalarawan pero para siyang normal day lang, walang kwento talaga.", "Neutral", "General Feedback", None),
    ("Grabe, akala ko I'd be stuck there forever pero super naging quick lang, sobrang na-appreciate ko.", "Positive", "Queueing and Waiting Time", None),
    ("Yung binisita kong doktor super thorough mag-explain, nag-take time talaga siya para sa akin.", "Positive", "Health and Medical Services - Consultation/Check-up", None),
    ("Nakakainis kasi paikot-ikot lang, iba't ibang building pinupuntahan ko bago nasagot yung tanong ko.", "Negative", "Communication and Information", None),
    ("Feeling ko medyo need pa ng improvement yung matriculation area, parang kulang sa organisasyon.", "Negative", "Enrollment and Registration - Matriculation", None),
    ("Salamat din sa scholarship staff, sobrang bait mag-explain kahit paulit-ulit akong nagtatanong.", "Neutral", "Scholarship and Financial Assistance - Scholarship Application/Grant", None),
    ("Grabe yung guidance session, sobrang naka-relate ako, na-gets ko yung sarili ko mas maigi.", "Positive", "Guidance and Counseling Services", None),
    ("Sabi nila mabilis daw pero in reality umabot pa ako ng ilang oras bago natapos, sobrang di tugma.", "Positive", "General Feedback", None),
]

CASES += [
    # Extra lexicon-miss cases — English
    ("By the time I figured out where I was supposed to be, half my morning was already gone.", "Negative", "Communication and Information", None),
    ("I genuinely can't decide if I'd come back or not, it really could go either way for me.", "Neutral", "General Feedback", None),
    ("They clearly went the extra mile, checking in with me twice just to make sure I understood the next steps.", "Positive", "Communication and Information", None),
    ("It felt like everyone was working against the clock instead of working for the people in front of them.", "Negative", "Process Efficiency", None),
    ("I'd describe it as unremarkable in every sense of the word, nothing to praise, nothing to gripe about.", "Neutral", "General Feedback", None),

    # Extra lexicon-miss cases — Tagalog
    ("Buti na lang may kasama akong nakaalam kung saan pumunta, kasi mismong tanda wala talaga.", "Negative", "Communication and Information", None),
    ("Hindi ko rin masyadong naiintindihan bakit kailangan pang ulit-ulitin yung parehong hakbang.", "Negative", "Process Efficiency - Complexity/Red Tape", None),
    ("Kahit sa sobrang dami ng ginagawa, nagawan pa rin nila ng paraan para maasikaso ako ng maayos.", "Positive", "Staff Competence and Knowledge", None),
    ("Sa totoo lang parang standard day lang siya, walang kakaiba, walang masamang naramdaman.", "Positive", "General Feedback", None),
    ("Ilang beses akong nagtanong pero laging ibang tao ang sumasagot ng kanya-kanyang bersyon.", "Negative", "Communication and Information - Inconsistent/Contradicting Information", None),

    # Extra lexicon-miss cases — Taglish
    ("Parang super lucky ako kasi kakaunti lang tao that day, kaya naasikaso agad ako nila.", "Positive", "Queueing and Waiting Time", None),
    ("Honestly parang naiwan ako sa dilim, walang nagsabi sa akin ng buong proseso from start to finish.", "Negative", "Process Efficiency", None),
    ("Di ko masyadong ma-rate kasi parang neutral lang overall, walang tumatak sa akin.", "Neutral", "General Feedback", None),
    # Item updated 2026-08-31, same reasoning as the two cases above.
    ("Grabe, sobrang thoughtful nung nag-assist samin, sinigurado talaga niya na comfortable kami.", "Positive", "Courtesy and Attitude - Staff/Employee", None),
    ("Parang nawalan ako ng direksyon dahil bawat window iba-ibang instructions ang binibigay.", "Negative", "Communication and Information", None),
]

OFFICE_HINT_CASE = (
    "Maganda naman siguro pero wala akong masyadong masabi, ordinaryo lang.",
    "Positive", "General Feedback", "Health Services",
)
CASES.append(OFFICE_HINT_CASE)

# =============================================================================
# REQUIRED REGRESSION CASES (2026-09 no-meaningful-feedback / Transaction /
# Courtesy classification fixes). All 15 are lexicon/junk-hit — zero Gemini
# calls needed to resolve any of them, so this block never depends on network
# access or a configured GEMINI_API_KEY.
# =============================================================================
CASES += [
    # Gibberish / non-feedback — must NOT become "General Feedback".
    ("XZ", "Neutral", "No Feedback - No Feedback", None),
    ("hahhdahsdhas", "Neutral", "No Feedback - No Feedback", None),
    ("Hfrrg", "Neutral", "No Feedback - No Feedback", None),
    # Greetings — valid text, but not service feedback.
    ("Hello po", "Neutral", "No Feedback - No Feedback", None),
    ("Hi", "Neutral", "No Feedback - No Feedback", None),
    ("Hi po", "Neutral", "No Feedback - No Feedback", None),
    # Transaction — General only when no speed/duration evidence is present.
    ("Hindi maayos yung transaction", "Negative", "Transaction - General", None),
    ("Maayos yung transaction", "Positive", "Transaction - General", None),
    ("Mabagal yung transaction", "Negative", "Transaction - Slow", None),
    ("Matagal yung transaction", "Negative", "Transaction - Slow", None),
    ("Mabilis yung transaction", "Positive", "Transaction - Fast", None),
    # Courtesy and Attitude — generic attitude judgment about unspecified
    # people ("sila") with no role noun or specific complaint phrase.
    ("Mababait sila", "Positive", "Courtesy and Attitude", None),
    ("Masungit sila", "Negative", "Courtesy and Attitude", None),
    ("Magalang sila", "Positive", "Courtesy and Attitude", None),
    ("Hindi mabait sila", "Negative", "Courtesy and Attitude", None),
]

# =============================================================================
# 2026-09-19 fixes: plural "good(s)" sentiment gap, queue-length ("mahaba")
# sentiment gap, "mali"/"wrong" sentiment gap, and a new "Insufficient
# Amount" subtopic under Scholarship and Financial Assistance (bare "grant"
# keyword + wrong/insufficient amount phrasing). Each admin-reported comment
# plus several similar variations, per the project's root-cause regression
# rule (never patch just the one failing sentence).
# =============================================================================
CASES += [
    # "all goods" — plural breaks the bare "good" word-boundary match.
    ("All goods transaction", "Positive", "Transaction - General", None),
    ("All goods naman transaction namin", "Positive", "Transaction - General", None),
    ("Complete naman lahat, all goods ang transaction ko today.", "Positive", "Transaction - General", None),

    # Queue-length ("mahaba ang pila") sentiment gap.
    ("Masyadong mahaba ang pila.", "Negative", "Queueing and Waiting Time - Long Lines", None),
    ("Ang haba ng pila dito, sobrang haba talaga.", "Negative", "Queueing and Waiting Time - Long Lines", None),
    ("Napakahaba ng pila kanina, mahabang oras din ang inabot.", "Negative", "Queueing and Waiting Time - Long Lines", None),

    # New "Insufficient Amount" subtopic — bare "grant" keyword gap.
    ("Kulang yung grant na nareceive ko.", "Negative", "Scholarship and Financial Assistance - Insufficient Amount", None),
    ("Kulang po yung grant na natanggap ko this semester.", "Negative", "Scholarship and Financial Assistance - Insufficient Amount", None),

    # New "Insufficient Amount" subtopic — wrong-amount phrasing.
    ("Mali yung amount na nailagay sa receipt ko.", "Negative", "Scholarship and Financial Assistance - Insufficient Amount", None),
    ("Mali ang amount na nasa resibo ko, kulang po.", "Negative", "Scholarship and Financial Assistance - Insufficient Amount", None),
    ("Kulang yung halaga na nasa resibo ko para sa grant ko.", "Negative", "Scholarship and Financial Assistance - Insufficient Amount", None),
]

# Short, plainly meaningful comments that must NOT be swept up by the
# strengthened gibberish/no-meaningful-feedback detector above (B3 in the
# task: don't overfit the detector to reject short real feedback).
NOT_GIBBERISH_CASES = [
    "Good", "Slow", "Okay", "Helpful", "Mabait", "Magalang", "Matagal", "Mabilis",
]


def classify_bucket(text):
    """Returns (sent_bucket, topic_bucket) — each 'lexicon-hit' or 'lexicon-miss'."""
    sent_bucket = "lexicon-hit" if tc.lexicon_sentiment(text) else "lexicon-miss"
    topic_bucket = "lexicon-hit" if tc.keyword_topic_override(text) else "lexicon-miss"
    return sent_bucket, topic_bucket


def run():
    t0 = time.time()
    sent_results = {"lexicon-hit": [0, 0], "lexicon-miss": [0, 0]}  # correct, total
    topic_results = {"lexicon-hit": [0, 0], "lexicon-miss": [0, 0]}
    failures = []

    for case in CASES:
        text, expected_sent, expected_topic, office_hint = case
        sent_bucket, topic_bucket = classify_bucket(text)

        got_sent = hm.classify_sentiment(text)
        got_topic = hm.classify_topic(text, office_hint=office_hint)

        sent_results[sent_bucket][1] += 1
        if got_sent == expected_sent:
            sent_results[sent_bucket][0] += 1
        else:
            failures.append(("SENTIMENT", sent_bucket, text, expected_sent, got_sent))

        topic_results[topic_bucket][1] += 1
        if got_topic == expected_topic:
            topic_results[topic_bucket][0] += 1
        else:
            failures.append(("TOPIC", topic_bucket, text, expected_topic, got_topic))

    def pct(correct, total):
        return f"{correct}/{total} ({100.0 * correct / total:.1f}%)" if total else "n/a"

    print(f"\n=== Ran {len(CASES)} cases in {time.time() - t0:.1f}s ===\n")

    print("--- SENTIMENT ---")
    for bucket in ("lexicon-hit", "lexicon-miss"):
        c, t = sent_results[bucket]
        print(f"  {bucket:14s}: {pct(c, t)}")
    total_c = sum(v[0] for v in sent_results.values())
    total_t = sum(v[1] for v in sent_results.values())
    print(f"  {'overall':14s}: {pct(total_c, total_t)}")

    print("\n--- TOPIC ---")
    for bucket in ("lexicon-hit", "lexicon-miss"):
        c, t = topic_results[bucket]
        print(f"  {bucket:14s}: {pct(c, t)}")
    total_c = sum(v[0] for v in topic_results.values())
    total_t = sum(v[1] for v in topic_results.values())
    print(f"  {'overall':14s}: {pct(total_c, total_t)}")

    if failures:
        print(f"\n--- FAILURES ({len(failures)}) ---")
        for kind, bucket, text, expected, got in failures:
            print(f"  [{kind}/{bucket}] expected={expected!r} got={got!r}\n    text={text!r}")

    print("\n--- NOT-GIBBERISH SANITY CHECK ---")
    gibberish_failures = []
    for text in NOT_GIBBERISH_CASES:
        junk = tc.detect_junk_topic(text)
        status = "PASS" if not junk else "FAIL"
        if junk:
            gibberish_failures.append(text)
        print(f"  [{status}] {text!r} -> detect_junk_topic={junk!r}")
    failures.extend(("NOT-GIBBERISH", "n/a", text, None, "flagged as junk") for text in gibberish_failures)

    return sent_results, topic_results, failures


if __name__ == "__main__":
    run()
