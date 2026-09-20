# Literature-guided synthesis: building a Python line as a sequence of Jev Choices

Topic `lit-synthesis`, 2026-09-20. Scripts: `experiments/lit-synthesis/slot-probe.mts` (live pilot),
`experiments/lit-synthesis/report-tables.mts` (renders the tables below from `results/slot-probe-b{1,3,5}.json`).
Model `typesafe/jev-1.13-20260917` via OpenRouter. Total live spend for this topic: see §5 (all runs together
stayed under $0.20 of the $1.00 cap).

Reading guide: §1 is the literature survey (URL and fetch date per claim). §2 answers the Python-parsing
question. §3 is the proposed scheme. §4 is the cost/latency model. §5 is the pilot that tests the scheme's
riskiest assumption (does Jev's judgment survive a left-to-right sequence of slot Choices?) on QuixBugs.
§6 says what it means for the design.

## 1. Literature survey

Every row was fetched on 2026-09-20. Where the primary page was blocked (ACM DL 403, arXiv PDF unreadable by
the fetch tool, HAL/OpenReview bot-walls), the row says which alternative source the claim comes from and
which details are from memory of the paper rather than the fetched text.

| # | Work | What it does, in one breath | The transferable idea for a Jev-only synthesiser | Source (fetched 2026-09-20) |
| --- | --- | --- | --- | --- |
| 1 | Neural-guided deductive search, Kalyan, Mohta, Polozov, Batra, Jain, Gulwani, ICLR 2018 | PROSE's deductive search branches over grammar productions (witness functions split the I/O spec into sub-specs); an LSTM scores each branch by the predicted quality of the best program below it; search follows the best branches. "Up to 12× speed-up" over PROSE on real spreadsheet tasks while keeping generalisation. | Exactly our shape: code proposes branches (productions), a scorer picks. Their scorer is a trained LSTM; ours is Jev with the spec (failing test) and the partial program in the state. Their lesson: score branches at the *production* level, not the token level, and keep a branch-and-bound fallback so the scorer can only reorder, never exclude. | https://arxiv.org/abs/1804.01186 (abstract; the PDF fetch returned binary, branch-scoring details from the paper as remembered) |
| 2 | DreamCoder, Ellis, Wong, Nye, Sablé-Meyer, Morales, Hewitt, Cary, Solar-Lezama, Tenenbaum, 2020 | Wake/sleep: a recognition network predicts "a distribution over grammar productions conditioned on the task"; that distribution guides enumerative search in the wake phase; the sleep phase grows a library of reusable abstractions. | A *task-conditioned prior over productions* is what a Choice over shapes gives us for free, per task, without training. The library-learning half maps onto "fix templates" and "donor fragments" mined from the repository: recurring fragments become named productions in the shape Choice. | https://arxiv.org/abs/2006.08381 |
| 3 | FlashMeta / PROSE, Polozov & Gulwani, OOPSLA 2015 | Witness functions capture "the inverse semantics of the underlying operator" so an I/O example on an expression becomes examples on its sub-expressions; version-space algebra represents all consistent programs; a ranker picks one. "10+ existing industrial-quality mass-market applications based on PBE can be cast as instances" and each used to take "1–2 man-years". | Inverse semantics is how *tests prune before the line is finished*: from `expected` and the partial line we can often compute what a sub-expression must evaluate to (e.g. a `return` of a call means the call's value is the expected value). Cheap for the arithmetic/comparison/slice operators that dominate one-line fixes. | https://www.microsoft.com/en-us/research/publication/flashmeta-framework-inductive-program-synthesis/ |
| 4 | Sketch, Solar-Lezama, Tancau, Bodík, Seshia, Saraswat, ASPLOS 2006 (and Solar-Lezama's 2008 thesis) | A sketch is a program with holes `??`; "the synthesizer then completes the sketch to behave like the specification" by combinatorial search over generalised SAT (CEGIS: inductive synthesiser plus validator). "Complete for the class of finite programs"; synthesised the hardest part of AES "in about an hour". | The buggy line *is* a sketch once the wrong token is replaced by a hole (§3, decision D3). Holes must be finite and typed (index expressions, lookup tables, bitmasks): our slot classes ident / attr / oper / num are the typed holes; the option sets are the finitisation. CEGIS's validator is our test oracle. | https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/1168857.1168907 (abstract; ACM DL returned 403) |
| 5 | DeepCoder, Balog, Gaunt, Brockschmidt, Nowozin, Tarlow, ICLR 2017 | A network predicts "properties of the program that generated the outputs from the inputs" (which DSL functions occur); enumerative and SMT search use these as priors ("sort and add"); "an order of magnitude speedup". | Ask Jev the attribute questions first: a batch of Nouls "does the fix involve a slice / a comparison / a call to `len` / a `- 1`" on the failing test and buggy function, then order option sets by those answers. One request, free reordering of the whole search. | https://arxiv.org/abs/1611.01989 |
| 6 | Euphony, Lee, Heo, Alur, Naik, PLDI 2018 | A probabilistic higher-order grammar learned from past solutions weights each production by context; a weighted (A*-style) enumeration visits programs in likelihood order; beats FlashFill on 20/22 problems and is ~10× faster on average. | Likelihood-ordered enumeration is beam search over Choice probabilities with the log-probabilities summed. Their PHOG conditions the production weight on the *parent and left context*; our prefix-mode Choice conditions on exactly that (the concrete prefix plus the sketch of what follows). | https://pldi18.sigplan.org/details/pldi-2018-papers/30/Accelerating-Search-Based-Program-Synthesis-using-Learned-Probabilistic-Models (abstract) and https://www.cis.upenn.edu/~alur/PLDI18.pdf (numbers from the search summary) |
| 7 | Synchromesh, Poesia, Polozov, Le, Tiwari, Soares, Meek, Gulwani, ICLR 2022 | Constrained Semantic Decoding: a *completion engine* returns, for any partial program, the set of tokens that keep it grammatically, type- and scope-valid; decoding only samples from that set. Target Similarity Tuning picks few-shot examples by target-program similarity. Gains on SQL, Vega-Lite, SMCalFlow and fewer run-time errors. | The completion engine is our option-set builder. Because Jev only ever sees options that *code* has generated, we get Synchromesh's guarantee (no ungrammatical, out-of-scope or ill-typed line) by construction, and Jev's "literal reading" weakness never has to be defended against invalid tokens. | https://arxiv.org/abs/2201.11227 |
| 8 | PICARD, Scholak, Schucher, Bahdanau, EMNLP 2021 | An incremental parser (attoparsec) rejects inadmissible tokens at each beam step; three modes: lexing, parsing without guards, parsing with guards (guards check table/column existence and type compatibility); beam size 4; turns passable T5 models into state of the art on Spider/CoSQL. | Incremental *validity* checks are cheap and belong between Jev steps: after each slot fill, `compile()` the line with remaining holes replaced by a dummy name; drop beam items that fail. Their beam of 4 is the size range we measured (§5: B=3 versus 5). | https://arxiv.org/abs/2109.05093 and https://arxiv.org/pdf/2109.05093 |
| 9 | Grammar-constrained decoding, Geng, Josifoski, Peyrard, West, EMNLP 2023 | A CFG masks the token distribution at every step; *input-dependent grammars* build a different grammar per input (e.g. only the entities mentioned in the text); constrained models beat unconstrained and even fine-tuned ones when data is scarce. | "Input-dependent grammar" is the precise name for what we do: the grammar for one fix contains only the identifiers in scope, the attributes seen on the receiver, the literals in the tests. Each program gets its own tiny grammar, so the Choice never exceeds a few dozen options. | https://arxiv.org/abs/2305.13971 |
| 10 | AlphaCode, Li et al. (DeepMind), 2022 (Science, Dec 2022) | "Large-scale model sampling to explore the search space, followed by filtering based on program behavior to a small set of submissions"; clustering samples by their outputs on model-generated inputs; 10 submissions; "top 54.3 %" of participants in Codeforces contests with >5,000 entrants. The paper's figures (up to ~1M samples per problem, ~99 % removed by the example tests, one pick per cluster of the 10 largest) are from memory: the PDF was unreadable by the fetch tool. | Two tools transfer directly. (a) Filtering by tests is the oracle we already have; (b) *behavioural clustering*: when several candidate lines pass the visible tests, run them on extra generated inputs and group by output; identical-behaviour candidates are one hypothesis, and Jev's ranking picks among clusters, not individuals. This is also the standard defence against test-overfitting patches in program repair. | https://arxiv.org/abs/2203.07814 (abstract) and https://deepmind.google/discover/blog/competitive-programming-with-alphacode/ |
| 11 | FUDGE, Yang & Klein, NAACL 2021 | A lightweight classifier trained on *prefixes* predicts whether the finished text will have the attribute; its probability re-weights the generator's next-token distribution (Bayesian factorisation P(token|prefix,attr) ∝ P(token|prefix)·P(attr|prefix+token)); composable across attributes. | A beam whose scorer is a classifier over prefixes is FUDGE with Jev as the classifier and a uniform (or code-derived) base distribution. Their key requirement, that the classifier be trained on partial sequences, is what our prefix-mode measurement (§5) checks for Jev zero-shot: does it judge an unfinished line as well as a finished one? | https://arxiv.org/abs/2104.05218 |
| 12 | Write, Execute, Assess, Ellis, Nye, Pu, Sosa, Tenenbaum, Solar-Lezama, NeurIPS 2019 | A REPL "immediately executes partially written programs, exposing their semantics"; a policy proposes the next piece, a value network assesses the executed partial state; Sequential Monte Carlo search over candidates. | Execute what can be executed before asking Jev: for a `return`/assignment fix, evaluate the partial expression on the failing test's inputs and put the *observed value* next to the *expected value* in the state. Jev compares values well ("verifying a stated arithmetic fact works well", REPORT §10) even though it cannot compute them. | https://arxiv.org/abs/1906.04604 |
| 13 | SketchAdapt, Nye, Hewitt, Tenenbaum, Solar-Lezama, ICML 2019 | A neural model emits a sketch with holes and a symbolic enumerator fills them; the model learns "when to rely on pattern recognition and when to perform symbolic search" without direct supervision. | The split between D3 (shape, judged by Jev) and D4+ (slots, searched with Jev as ranker but tests as arbiter) is their split. Their finding that the hybrid beats either half alone is the argument for not asking Jev to pick a whole line among hundreds of fully-formed candidates when the candidate set gets large. | https://arxiv.org/abs/1902.06349 |
| 14 | GumTree, Falleri, Morandat, Blanc, Martinez, Monperrus, ASE 2014 | AST-granularity edit scripts with move actions: "compute edit scripts that are short and close to the original developer intent"; matching is top-down (greedy isomorphic subtrees) then bottom-up (containers by Dice similarity, with an optimal algorithm on small subtrees), then Chawathe-style script generation (update / insert / delete / move). Phase details from memory; the fetched abstract confirms scope and goals (629 citations). | Edit scripts define *edit classes*: on QuixBugs the fix is a single token update in 11/36 one-line cases, a fragment insertion in 16, a deletion in 5, a reshape in 4 (§5.1). D1 in §3 is a Choice over these classes, and the LCS token diff that scores the pilot is a one-line special case of an edit script. Levenshtein on tokens (not characters) is enough at line granularity; AST-level scripts matter for multi-line fixes. | https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/2642937.2642982 (abstract; ACM DL and HAL blocked) and https://github.com/GumTreeDiff/gumtree |
| 15 | Prophet, Long & Rinard, POPL 2016 | Learns "a probabilistic, application-independent model of correct code" from successful human patches and uses it to rank candidate patches before validation; evaluated on 69 real bugs, better than prior generate-and-validate systems. | The direct ancestor of "Jev ranks, tests validate". Prophet needed a trained model and a fixed feature set; Jev is the zero-shot ranker. Prophet's search space (a few hundred to thousands of candidates per bug) is the size at which one 255-way Choice or a beam of a few steps operates. | https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/2837614.2837617 |
| 16 | tree-sitter (incremental parsing; web-tree-sitter) | Edit the old tree (`ts_tree_edit`) then re-parse: "this will create a new tree that internally shares structure with the old tree." The WASM binding needs `tree-sitter.wasm` plus a per-language `.wasm` (`Parser.init()`, `Language.load('tree-sitter-python.wasm')`); built with `tree-sitter build --wasm`; in Node it "is considerably slower than running Node.js bindings". `web-tree-sitter` 0.27.0 has no runtime dependencies; `tree-sitter-python` 0.25.0 lists `*.wasm` in `files` but its install script runs `node-gyp-build` (native addon deps `node-addon-api`, `node-gyp-build`). | Incremental parsing is irrelevant at our scale (one line in a ≤ 1k-line file re-tokenises in microseconds); what matters is *whether we need a Python parser at all* (§2). | https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html, https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md, https://unpkg.com/web-tree-sitter/package.json, https://unpkg.com/tree-sitter-python/package.json |
| 17 | Python lexical analysis (reference manual) | INDENT/DEDENT from a stack of indentation levels (push and emit INDENT when larger, pop and emit one DEDENT per popped level when smaller, must match a stack value); implicit line joining inside `()[]{}`; explicit joining with `\`; NAME/NUMBER/STRING (prefixes `r b f u`, triple quotes)/OP token classes; keyword list; comments end the logical line unless inside brackets. | The spec for the minimal tokenizer in §2. | https://docs.python.org/3/reference/lexical_analysis.html |

What the survey says as a whole: every successful search-based synthesiser separates *proposal* (a grammar or
DSL enumerated by code, made small by input-dependent constraints) from *scoring* (a learned model that
reorders branches) from *verification* (examples, tests or a solver), and every one of them scores at the
granularity of productions or sketches rather than raw characters. The Jev-only constraint forces this
separation and Jev fits the scoring slot; nothing in the survey requires the scorer to generate.

## 2. Parsing Python without new dependencies

- **Node ships no Python parser.** `node_modules` (84 packages) contains nothing that parses Python: `esbuild` 0.28.2
  is a 10.6 MB Go binary for JS/TS/CSS (`@esbuild/darwin-arm64/bin/esbuild`) and `tsx` 4.23.13 is a loader that
  depends only on `esbuild` (plus optional `fsevents`). A grep for `tree-sitter` or a Python grammar across every
  `package.json` in `node_modules` returns nothing.
- **web-tree-sitter would be one new dev dependency plus a `.wasm` grammar file** (`web-tree-sitter` 0.27.0 has no
  runtime deps; the Python grammar has to come from `tree-sitter-python`, whose npm package carries a native
  `node-gyp-build` install step, or be built once with `tree-sitter build --wasm` and vendored as a single file).
  It gives full ASTs, error recovery and incremental reparsing, none of which the one-line synthesiser needs.
- **The machine that runs the tests already has CPython** (`/usr/bin/python3` 3.9.6 here; any target repo we
  repair is Python). `python3 -c 'import ast,sys; ast.parse(sys.stdin.read())'` is a zero-dependency full parser
  at ~30 ms per call, and `tokenize`/`ast` can dump scope information (function params, assigned names, attribute
  accesses) as JSON in one subprocess call per file. Since the agent already shells out to run tests, using the
  interpreter as the parser adds no dependency, only a subprocess; the sandbox rules that apply to `pytest`
  apply to it.
- **A hand-written tokenizer is ~25 lines and is exact on this corpus.** `slot-probe.mts` contains one regex
  tokenizer (strings with prefixes, numbers, names, 3/2/1-character operators, comments stripped) and
  `KEYWORDS`/`KW_OPS`/`OPS` sets. Validated against CPython's `tokenize` module on all 440 non-blank,
  non-comment code lines of the 41 QuixBugs Python programs: **413/413 identical token sequences** on the lines
  CPython can tokenize in isolation (the remaining 27 are fragments of bracketed multi-line statements, which
  CPython's tokenizer rejects alone and ours tokenizes; 0 disagreements). What a *line grammar* on top of it
  needs, in order of necessity: (1) bracket depth to join implicit continuation lines into one logical line;
  (2) the indentation stack from the reference manual to recover block structure (which lines belong to which
  `def`/`for`/`if`, so the scope scan knows the enclosing function); (3) backslash continuation and
  triple-quoted strings spanning lines; (4) a 10-way statement-kind classifier by leading keyword or assignment
  operator (already in the script as `kindOf`). That is roughly 150 lines total and needs no AST: slot classes
  (identifier / attribute / operator / number) are lexical, and the only structural facts the synthesiser
  uses (scope roles, receivers, the shape of neighbouring lines) are regular.
- **Recommendation.** Hand-written tokenizer plus indentation-aware logical-line splitter in TypeScript for
  proposal building (fast, in-process, tested), and `python3 -c 'compile(...)'` as the syntactic validity
  gate between beam steps (PICARD's "parsing without guards"), with `ast`-derived scope JSON as an optional
  enrichment when a file is large. No new npm dependency.

## 3. Proposed scheme: grammar-guided Choice synthesis for one Python line

The unit of work is *one logical line at a known location* (the localisation stage of the anchor probe
supplies the line: top-1 13/14, top-3 14/14). The decision sequence is fixed and short; every option set is
built by code from the file, the failing test and a small table of productions; Jev only ever answers Choices
over those options (each with the `none_of_these` escape the `choice()` builder adds), and the tests decide.

### 3.1 Decision sequence

| Step | Decision (Jev primitive) | Option set (built by code) | Bound |
| --- | --- | --- | --- |
| D1 edit class | Choice: `substitute_one_token`, `insert_fragment`, `delete_fragment`, `reshape_line`, `insert_new_line_before`, `insert_new_line_after`, `change_several_lines` (escape) | fixed list | 1 |
| D2 anchor | Choice over the tokens of the buggy line ("which token is wrong", escape `a_token_is_missing`); if D1 is insert: Choice over the gaps between tokens | ≤ 40 tokens/gaps | 1 |
| D3 shape (sketch) | Choice over candidate shapes: (a) buggy shape with the D2 token turned into a typed hole; (b) buggy shape with one fragment production inserted at the D2 gap, from a fragment table (`[?:]`, `[?]`, `[?:?]`, `- ?`, `+ ?`, `or not ?`, `and ?`, `(?)`, `? ,`, `len(?)`, `.?(?)`, …, ~20 entries); (c) buggy shape with the D2 fragment deleted; (d) shapes of the other lines of the same function/file with identifiers abstracted (donors); (e) for a new line, statement-kind templates (`return ?`, `if ?:`, `? = ?`, `?.append(?)`, `raise ?`, `continue`) | ≤ 255, rank-ordered by D1 | 1 |
| D4 … D(3+k) slot fills | one Choice per typed hole, left to right, on the concrete prefix plus the sketch of what follows (`?` for unfilled holes); B beam items per step asked as B independent questions in **one request** | per hole: identifiers ≤ 60, attributes ≤ 40, operators 24, numbers ≤ 30 | k ≤ 12 (35/36 QuixBugs fixed lines have ≤ 10 slots, median 5) |
| V verify | code: `compile()` each completed line; run the oracle tests on the top-B lines; if several pass, cluster by behaviour on extra inputs and let one Choice pick the cluster | – | 0 Jev requests |

Worst case 3 + 12 + 1 = 16 decisions per line, 3 + k requests (D1–D3 can share one request when asked on the
same state, since they are independent questions; D2's answer only reorders D3's options, so the cheap route
asks all three at once and lets code apply the ordering). The ≤ 30-decision budget then allows two shape
retries (D3 re-asked with the failed shapes removed) before the outer loop widens localisation.

### 3.2 How option sets are built

- **Identifiers in scope**: a static scan of the file (regexes over `def name(params)`, `for x in`, assignment
  targets, `import ... as`, every other name; roles are attached: "parameter of `kth`", "local variable assigned
  at line 7", "function defined at line 1", "Python builtin"). Ordered: enclosing function's params and locals,
  then module-level names, then a fixed builtin list. Each option's description is the backticked identifier
  plus its role (REPORT §11: descriptions carry more weight than keys). Cap 60.
- **Attributes of a receiver**: every `.name` seen on the same receiver in the file, then every attribute seen in
  the file, then a short list of common `list`/`dict`/`str`/`deque` methods; with `ast` available, the class's
  methods when the receiver's class is defined locally. Cap 40.
- **Literals from tests**: integers with |x| ≤ 100 that appear in the failing test's inputs or expected output,
  every numeric literal already in the file, and {0, 1, 2, 3, 10}; strings: every string literal in the tests
  and in the file. Cap 30.
- **Operators**: the fixed table of 24 (arithmetic, comparison, boolean, membership/identity, bitwise), each
  described by its symbol. When the hole came from a substitution, the buggy operator stays in the set (the
  escape is a separate option) so the Choice measures *is a change needed here*, not just *which*.
- **Fragments** (for D3 (b)): mined once from a corpus of one-line fixes (QuixBugs gold: `[1:]`, `[k:]`,
  `- num_lessoreq`, `or not coins`, `[i - 1, j - 1]`, `rest_subsets +`) and kept as ~20 productions with typed
  holes.

### 3.3 Bounding the sequence

Shapes with more than 12 holes are never offered; holes that D2 did not point at are pre-filled with the buggy
line's own token *and* kept as a hole only when the shape came from a donor. In the repair setting this makes
the typical sequence 1 request for D1–D3 and 1–3 requests for the differing slots (the S2 condition in §5: 1.7
holes on average), i.e. 2–4 requests per attempt; full synthesis of a line from its shape alone (S1) is the
fallback and costs 1 + k requests.

### 3.4 Beam width versus cost

One request per step carries all B beam items (the state holds `candidates.{first,…}`, one Choice each), so
**latency is independent of B** (~230–250 ms per step) and cost grows only with the option tokens repeated per
question (B × options × ~10 tokens). §5 measures B ∈ {1, 3, 5}.

### 3.5 How tests prune

1. Between steps: `compile()` of the line with `?` replaced by a dummy name removes syntactically dead beam items
   (free, in-process or one `python3 -c`).
2. After completion: run the oracle tests (those the reference passes within an alarm; in the field, the
   failing test plus the module's passing tests) on beam items in rank order; stop at the first that passes.
3. When several pass (over-fitting risk): AlphaCode-style behavioural clustering on 5–10 generated inputs; a
   single Choice over the clusters with the diff, the failing test and one representative per cluster.
4. When none passes: the executed values of the failing candidates (REPL idea, row 12) go into the state for a
   Noul per candidate "does `observed` move toward `expected`", which orders the D3 retry.

## 4. Cost and latency per synthesised line (from Jev's measured numbers)

Constants: 234–248 ms Jev p50 measured in this pilot (REPORT: 167 ms p50 sequential, flat in question count, rising
with state size: 10k-token state 242 ms, 30k 372 ms); $0.042 per million input tokens; measured here
**$0.00012 per request** with a 2–3k-token state (a QuixBugs program, 4 tests, the buggy line, up to 60 options
per Choice, 1–12 Choices per request). A 40-line python program plus tests is ~1k tokens; a 1,500-line SWE-bench
file is ~15k tokens, so state dominates and one request there is ~$0.0006–0.0008 and ~260 ms.

| Scenario | Requests | Latency (Jev only) | Jev cost (QuixBugs-sized state) | Jev cost (15k-token file in state) | Test runs |
| --- | --- | --- | --- | --- | --- |
| Repair attempt, edit-class + anchor + shape in one request, 2 differing slots (S2 typical) | 3 | ~0.7 s | $0.0004 | $0.002 | B |
| Full line from shape, median 5 slots (S1 typical) | 6 | ~1.4 s | $0.0007 | $0.004 | B |
| Full line, 12 slots (worst allowed) | 13 | ~3.1 s | $0.0016 | $0.009 | B |
| Attempt with two D3 retries (30-decision budget) | ≤ 30 | ≤ 7.5 s | ≤ $0.004 | ≤ $0.02 | ≤ 3B |
| 29 QuixBugs programs, S1 + S2 + probe, B = 3 (measured, §5) | 227 | ~3 min wall at 6-way concurrency | $0.026 | – | ~150 |

Test execution, not Jev, is the latency floor: one QuixBugs oracle run is 50–100 ms; a SWE-bench module's tests
are seconds. Batching the B beam items into one request is what keeps a 12-slot line at ~3 s; asking them
one by one would be 3 × B seconds.

## 5. Pilot: does Jev's judgment survive a sequence of slot Choices? (QuixBugs, live)

Script `experiments/lit-synthesis/slot-probe.mts`; raw results `results/slot-probe-b{1,3,5}.json`; the tables
are rendered by `report-tables.mts`. 31 QuixBugs programs have JSON tests; 29 have a fix that replaces exactly one
line (`shunting_yard` and `wrap` insert a line and are skipped). Three complete runs at beam width B = 1, 3, 5.
Total spend for this topic including two development runs: ~$0.17 (cap $1.00). The run-level numbers below are
the summary printed by each run.

### 5.1 Set-up (exact state shape and question wording)

State (per program), `Json`:

```
{ task: "The Python function `<name>` in `program` has a single-line bug on `buggy_line`. `tests` give inputs and the expected output of the correct function.",
  program: { L1: "<line>", L2: "...", ... },          // non-blank, non-comment lines
  tests: [ { input: [...], expected: ... }, ... ],   // first 4 JSON test cases
  buggy_line: "<the buggy line, trimmed>",
  partial_lines: { cloze_1: "...", prefix_1: "...", ... }   // probe request only
  candidates: { first: "...", second: "...", third: "..." } // beam requests only }
```

Questions (all `choice()` from `src/jev/questions.ts`, so every one carries `none_of_these`):

- `kind`: "What kind of statement is the corrected line that must replace `buggy_line` so that `tests` pass?"
  Options: 10 statement kinds with descriptions (`return_statement`, `assignment`, `augmented_assignment`,
  `if_statement`, `elif_statement`, `while_loop`, `for_loop`, `yield_statement`, `call_statement`, `other_statement`).
- `wrong_token`: "Which token of `buggy_line` is wrong and must be changed or removed so that `tests` pass? Read the
  tokens literally." Options: one per token, described as ``token 3 of `buggy_line`: `<=` ``, plus
  `a_token_is_missing` ("no existing token is wrong; the line is wrong because a token or fragment is missing and
  must be inserted").
- `cloze_h`: "`partial_lines.cloze_h` is the corrected line that replaces `buggy_line` in `program`, with one token
  blanked as `<HOLE>`. Which option is the token at `<HOLE>` such that the line makes every entry of `tests` pass?
  Pick `none_of_these` if no option fits."
- `prefix_h` and the beam questions `fill_first` …: "`<path>` is a partially written replacement for `buggy_line` in
  `program`. Tokens before `<HOLE>` are fixed; each `?` is a token still to be filled in later. Which option is the
  correct token for `<HOLE>`, so that the finished line makes every entry of `tests` pass? Pick `none_of_these` if no
  option fits." Example partial line: ``return kth ( <HOLE> , ? - ? )``.
- Option sets exactly as §3.2 (identifiers with roles from the static scan, mean 29 options; operators 24; numbers
  from tests and file, mean 12.5; attributes 24). Option keys are `name_<ident>`, `op_plus`, `num_neg1`, `attr_append`.

Two synthesis conditions, both real left-to-right beams with fresh Jev calls on the *actual* beam prefixes (not
the gold prefix), one request per step carrying all B items:

- **S2 diff-fill**: the fixed line's shape is given; only the slots that differ from the buggy line (LCS token diff)
  are holes; everything else is copied from the buggy line. This is the repair path (D3 (a)/(b) after a correct
  anchor). Mean 1.7 holes (42 holes / 25 lines; the earlier draft said 1.8), run on the 25 programs where the differing slots
  were all inside the option sets (the other 4 have no differing *slot*: `flatten` and `levenshtein` are pure deletions,
  `subsequences` differs only in punctuation `[]` → `[[]]`, and `bitcount`'s `^=` → `&=` is an augmented-assignment
  operator that the tokenizer classes as punctuation, so it never becomes a hole).
- **S1 full-fill**: the fixed line's shape is given; *every* identifier / operator / number slot is a hole (mean 5.4,
  max 12). This isolates the slot-sequence question from anchoring.

Oracle: the QuixBugs JSON tests that the gold program passes within a 2 s per-test alarm *and* the runner's float
tolerance (`rel_tol = abs_tol = 1e-6`). All tests for 26 programs; `knapsack` (9/10) and `levenshtein` (6/7) each lose one
slow test; `sqrt` (5/7) loses two tests **not** to the alarm but to the tolerance: the gold Newton iteration returns
5.196176 and 5.744665 where the JSON expects 5.196165 and 5.744628 (2 × 10⁻⁶ relative), so those two tests are
unreachable for any candidate. A candidate "passes" if it passes every oracle test. The gold line passes 25/25 (S2) and
29/29 (S1) by construction (the oracle is *defined* as the tests the gold passes), so this is a consistency check, not
evidence of soundness.

What is *given* to the pilot and would have to be decided in the real system: the line (anchor probe: 13/14 top-1),
and the fixed line's shape (D3). §5.4 quantifies how often that shape is trivially available.

### 5.2 Results

| Beam B | Programs | Jev requests | Retries | Cost | Jev p50 | Jev p90 | Cost / request |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 29 | 227 | 0 | $0.0198 | 248 ms | 401 ms | $0.00009 |
| 3 | 29 | 227 | 0 | $0.0270 | 234 ms | 439 ms | $0.00012 |
| 5 | 29 | 227 | 0 | $0.0342 | 248 ms | 577 ms | $0.00015 |

| Run | `kind` top-1 | `wrong_token` top-1 | Slots | Covered | Cloze top-1 | Prefix top-1 | Cloze MRR | Prefix MRR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B=1 | 29/29 (100 %) | 21/29 (72 %) | 156 | 156/156 (100 %) | 142/156 (91 %) | 144/156 (92 %) | 0.95 | 0.96 |
| B=3 | 29/29 (100 %) | 21/29 (72 %) | 156 | 156/156 (100 %) | 144/156 (92 %) | 145/156 (93 %) | 0.96 | 0.96 |
| B=5 | 29/29 (100 %) | 21/29 (72 %) | 156 | 156/156 (100 %) | 144/156 (92 %) | 141/156 (90 %) | 0.96 | 0.95 |

| Slot class | n | Options per Choice (mean) | Covered | Cloze top-1 | Prefix top-1 | Prefix MRR | Mean P(truth) prefix | Mean P(escape) prefix |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ident | 93 | 29.1 | 93/93 (100 %) | 85/93 (91 %) | 83/93 (89 %) | 0.94 | 0.73 | 0.11 |
| attr | 1 | 24.0 | 1/1 (100 %) | 1/1 (100 %) | 1/1 (100 %) | 1.00 | 0.98 | 0.02 |
| oper | 38 | 24.0 | 38/38 (100 %) | 34/38 (89 %) | 37/38 (97 %) | 0.99 | 0.78 | 0.10 |
| num | 24 | 12.5 | 24/24 (100 %) | 24/24 (100 %) | 24/24 (100 %) | 1.00 | 0.75 | 0.20 |

| Beam B | S2 diff-fill ran | S2 tests pass (any rank) | S2 pass at rank 1 | S2 truth in beam | S1 full-fill ran | S1 tests pass | S1 pass at rank 1 | S1 truth in beam | S1 mean holes | S1 requests / line |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 25 | 18/25 (72 %) | 18 | 18/25 (72 %) | 29 | 14/29 (48 %) | 14 | 12/29 (41 %) | 5.4 | 5.4 |
| 3 | 25 | 23/25 (92 %) | 19 | 23/25 (92 %) | 29 | 22/29 (76 %) | 18 | 21/29 (72 %) | 5.4 | 5.4 |
| 5 | 25 | 23/25 (92 %) | 19 | 23/25 (92 %) | 29 | 24/29 (83 %) | 20 | 22/29 (76 %) | 5.4 | 5.4 |

Per-program rows, B=3 run. "wrong" = which token of the buggy line is wrong (truth from an LCS token diff; "missing" when the fix only inserts). Slots = ident/oper/num tokens of the fixed line. S2 = beam over only the differing slots; S1 = beam over every slot. "pass@r" = rank of the first beam candidate that passes every oracle test (0 = none); "truth@r" = rank of the gold line in the beam. Requests = 1 probe request + S1 steps + S2 steps (derived from the saved beam records; the raw per-program `requests`/`costUsd` fields are inflated by shared counters under 6-way concurrency and are not used). Cost (est.) = requests × the run's mean cost per request ($0.00012).

| Program | Buggy line → fixed line | Kind | Wrong token | Slots (cov / cloze / prefix) | S2 holes | S2 pass@ | S2 truth@ | S1 pass@ | S1 truth@ | Requests (1 + S1 + S2) | Cost (est.) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bitcount | `n ^= n - 1` → `n &= n - 1` | Y | Y p=0.97 | 4 (4 / 3 / 4) | – | – | – | 1 | 1 | 5 | $0.0006 |
| bucketsort | `for i, count in enumerate(arr):` → `for i, count in enumerate(counts):` | Y | Y p=0.99 | 5 (5 / 4 / 5) | 1 | 1 | 1 | none | out | 7 | $0.0008 |
| find_first_in_sorted | `while lo <= hi:` → `while lo < hi:` | Y | Y p=0.96 | 3 (3 / 3 / 3) | 1 | 1 | 1 | 1 | 1 | 5 | $0.0006 |
| find_in_sorted | `return binsearch(mid, end)` → `return binsearch(mid + 1, end)` | Y | n (tok4_mid) p=0.31 | 5 (5 / 5 / 5) | 2 | 1 | 1 | 1 | 1 | 8 | $0.0010 |
| flatten | `yield flatten(x)` → `yield x` | Y | Y p=0.99 | 1 (1 / 1 / 1) | – | – | – | 1 | 1 | 2 | $0.0002 |
| gcd | `return gcd(a % b, b)` → `return gcd(b, a % b)` | Y | Y p=0.74 | 5 (5 / 5 / 4) | 2 | 1 | 1 | 1 | 1 | 8 | $0.0010 |
| get_factors | `return []` → `return [n]` | Y | Y p=0.79 | 1 (1 / 1 / 1) | 1 | 1 | 1 | 1 | 1 | 3 | $0.0004 |
| hanoi | `steps.append((start, helper))` → `steps.append((start, end))` | Y | Y p=1.00 | 4 (4 / 3 / 3) | 1 | 1 | 1 | 2 | 2 | 6 | $0.0007 |
| is_valid_parenthesization | `return True` → `return depth == 0` | Y | Y p=0.67 | 3 (3 / 3 / 3) | 3 | 1 | 1 | 1 | 1 | 7 | $0.0008 |
| kheapsort | `for x in arr:` → `for x in arr[k:]:` | Y | Y p=0.57 | 4 (4 / 4 / 4) | 1 | 1 | 1 | 1 | 1 | 6 | $0.0007 |
| knapsack | `if weight < j:` → `if weight <= j:` | Y | Y p=0.96 | 3 (3 / 2 / 2) | 1 | 1 | 1 | 1 | 1 | 5 | $0.0006 |
| kth | `return kth(above, k)` → `return kth(above, k - num_lessoreq)` | Y | n (tok6_k) p=0.41 | 5 (5 / 4 / 4) | 2 | 1 | 1 | 1 | 1 | 8 | $0.0010 |
| lcs_length | `dp[i, j] = dp[i - 1, j] + 1` → `dp[i, j] = dp[i - 1, j - 1] + 1` | Y | n (tok14_j) p=0.25 | 12 (12 / 12 / 12) | 2 | 3 | 3 | none | out | 15 | $0.0018 |
| levenshtein | `return 1 + levenshtein(source[1:], target[1:])` → `return levenshtein(source[1:], target[1:])` | Y | Y p=0.66 | 5 (5 / 4 / 4) | – | – | – | 1 | 1 | 6 | $0.0007 |
| lis | `longest = length + 1` → `longest = max(longest, length + 1)` | Y | Y p=0.73 | 6 (6 / 5 / 4) | 2 | 1 | 1 | 1 | 1 | 9 | $0.0011 |
| longest_common_subsequence | `return a[0] + longest_common_subsequence(a[1:], b)` → `return a[0] + longest_common_subsequence(a[1:], b[1:])` | Y | n (tok15_b) p=0.16 | 8 (8 / 8 / 8) | 1 | 1 | 1 | 1 | 1 | 10 | $0.0012 |
| max_sublist_sum | `max_ending_here = max_ending_here + x` → `max_ending_here = max(0, max_ending_here + x)` | Y | Y p=0.85 | 6 (6 / 6 / 6) | 2 | 1 | 1 | 1 | 2 | 9 | $0.0011 |
| mergesort | `if len(arr) == 0:` → `if len(arr) <= 1:` | Y | Y p=0.71 | 4 (4 / 4 / 4) | 2 | 3 | 3 | 3 | 3 | 7 | $0.0008 |
| next_palindrome | `return [1] + (len(digit_list)) * [0] + [1]` → `return [1] + (len(digit_list) - 1) * [0] + [1]` | Y | n (tok10_x) p=0.13 | 10 (10 / 10 / 10) | 2 | 2 | 2 | none | out | 13 | $0.0015 |
| next_permutation | `if perm[j] < perm[i]:` → `if perm[i] < perm[j]:` | Y | n (tok6_x) p=0.00 | 5 (5 / 2 / 4) | 2 | none | out | 2 | out | 8 | $0.0010 |
| pascal | `for c in range(0, r):` → `for c in range(0, r + 1):` | Y | n (tok8_r) p=0.24 | 7 (7 / 7 / 7) | 2 | 2 | 2 | 2 | 2 | 10 | $0.0012 |
| possible_change | `if total < 0:` → `if total < 0 or not coins:` | Y | Y p=0.86 | 6 (6 / 5 / 5) | 3 | 1 | 1 | none | out | 10 | $0.0012 |
| powerset | `return [[first] + subset for subset in rest_subsets]` → `return rest_subsets + [[first] + subset for subset in rest_subsets]` | Y | Y p=0.78 | 8 (8 / 8 / 8) | 2 | 1 | 1 | 1 | 1 | 11 | $0.0013 |
| quicksort | `greater = quicksort([x for x in arr[1:] if x > pivot])` → `greater = quicksort([x for x in arr[1:] if x >= pivot])` | Y | Y p=0.95 | 10 (10 / 10 / 9) | 1 | 1 | 1 | 1 | 1 | 12 | $0.0014 |
| rpn_eval | `op(token, a, b)` → `op(token, b, a)` | Y | Y p=0.93 | 4 (4 / 4 / 4) | 1 | 1 | 1 | 1 | 1 | 6 | $0.0007 |
| sieve | `if any(n % p > 0 for p in primes):` → `if all(n % p > 0 for p in primes):` | Y | Y p=0.99 | 9 (9 / 8 / 9) | 1 | 1 | 1 | none | out | 11 | $0.0013 |
| sqrt | `while abs(x - approx) > epsilon:` → `while abs(x - approx ** 2) > epsilon:` | Y | n (tok6_approx) p=0.26 | 8 (8 / 8 / 8) | 2 | none | out | none | out | 11 | $0.0013 |
| subsequences | `return []` → `return [[]]` | Y | Y p=0.37 | 0 (0 / 0 / 0) | – | – | – | 1 | 1 | 1 | $0.0001 |
| to_base | `result = result + alphabet[i]` → `result = alphabet[i] + result` | Y | Y p=0.49 | 5 (5 / 5 / 4) | 2 | 1 | 1 | none | out | 8 | $0.0010 |

Prefix-mode slot misses (B=3 run): the token Jev ranked first versus the truth.

| Program | Slot truth | Class | Rank of truth | P(truth) | P(escape) | Options |
| --- | --- | --- | --- | --- | --- | --- |
| gcd | `b` | ident | 2 | 0.13 | 0.09 | 26 |
| hanoi | `start` | ident | 2 | 0.20 | 0.12 | 29 |
| knapsack | `weight` | ident | 2 | 0.17 | 0.40 | 33 |
| kth | `above` | ident | 2 | 0.31 | 0.03 | 32 |
| levenshtein | `source` | ident | 2 | 0.38 | 0.11 | 26 |
| lis | `longest` | ident | 2 | 0.12 | 0.10 | 32 |
| lis | `longest` | ident | 2 | 0.29 | 0.15 | 32 |
| next_permutation | `i` | ident | 3 | 0.02 | 0.23 | 28 |
| possible_change | `<` | oper | 2 | 0.09 | 0.07 | 24 |
| quicksort | `greater` | ident | 2 | 0.35 | 0.04 | 29 |
| to_base | `result` | ident | 2 | 0.32 | 0.16 | 30 |

### 5.3 Reading the numbers

- **Slots are easy for Jev, in either direction.** 156 slots, 100 % covered by the code-built option sets;
  top-1 91–92 % (cloze) and 90–93 % (prefix), MRR 0.95–0.96, stable across the three runs (the ±2-slot spread is
  the REPORT's mid-band noise). Seeing only the prefix costs nothing relative to seeing the whole line: Jev
  judges an unfinished line as well as a finished one, which is the FUDGE precondition (row 11). Numbers 24/24 (23/24 cloze at B = 1)
  and operators 34–37/38 are near-perfect; identifiers are the soft spot (81–85/93). In prefix mode every identifier
  miss has the truth at rank 2 (rank 3 once or twice per run) with P(truth) 0.12–0.38, i.e. exactly the beam's job; in
  cloze mode one identifier per run sits at rank 4, and one operator per run at rank 4 (B = 1, 3) or 5 (B = 5 prefix).
- **Beam width is the lever, and it is cheap.** Full-fill success 48 % → 76 % → 83 % for B = 1, 3, 5 (14, 22, 24 of
  29 lines built from the shape alone and verified by tests); diff-fill 72 % → 92 % → 92 % (18, 23, 23 of 25).
  Cost per request $0.00009 → $0.00012 → $0.00015 and p50 latency flat at 234–248 ms, because the B items travel
  in one request. Requests per line are the same at every width (5.4 for S1, 1.7 for S2).
- **Rank inside the beam is not enough; run the tests on all B.** At B = 3, 22 lines pass but only 18 pass at
  rank 1; `mergesort` and `lcs_length` pass at rank 3. Tests on B candidates cost B × ~70 ms and lift the result
  from 62 % to 76 %.
- **Passing is not the same as gold.** Three distinct non-gold lines pass across the runs. `next_permutation` passes
  with `if perm[j] > perm[i]:` (equivalent to the gold swap of `i` and `j`) in every run and the gold never enters its
  beam; `max_sublist_sum` passes at rank 1 with `max(0, x + max_ending_here)` (equivalent by commutativity) in every run,
  with the gold at rank 2 at B = 3 and 5 and out of the beam at B = 1; at B = 5 `possible_change` S1 passes with
  `if total <= 0 or not coins:` (a boundary that the tests do not distinguish, i.e. over-fitted). So at B = 3, 2 of the
  22 passing S1 lines are non-gold (both equivalent); at B = 5, 3 of 24 (two equivalent, one over-fitted). Behavioural clustering on extra inputs (row 10) is how to tell
  equivalent from over-fitted.
- **`wrong_token` is 21/29 strictly and 29/29 as an anchor.** All eight "misses" are informative: seven are the
  fragment-insertion cases (`mid` → `mid + 1`, `k` → `k - num_lessoreq`, `j` → `j - 1`, `b` → `b[1:]`,
  `len(digit_list)` → `len(digit_list) - 1`, `r` → `r + 1`, `approx` → `approx ** 2`) and in every one Jev picked
  the token *immediately before the insertion point* instead of the `a_token_is_missing` escape; the eighth
  (`next_permutation`) picked the `<` operator, which is the equivalent fix the beam later found. So the anchor
  is right 29/29 and the *edit class* (substitute vs insert) is what the escape option fails to carry: it needs
  to be its own Choice (D1) asked with descriptions and examples, not an escape row.
- **`kind` is 29/29 but uninformative here**: every QuixBugs replacement keeps the buggy line's statement kind.
  It matters only for inserted lines (D3 (e)), which this pilot does not cover.
- **Where it fails.** `sqrt` (`approx` → `approx ** 2` inside `abs(...)`) fails in every condition: the shape has two
  holes (`**`, `2`) and Jev puts 0.09–0.20 on `**` at the first step; a 4-test state with floats does not pin the
  power. `lcs_length` (12 slots) fails full-fill at every width, the longest line in the set. `possible_change`
  is unstable across runs: S2 (`or not coins`, 3 holes) passes at B = 3 and fails at B = 1 and B = 5, while S1 fails at
  B = 1 and 3 and passes non-gold at B = 5; `kheapsort`'s `wrong_token` is missed at B = 1 and hit at B = 3, 5, while
  `sqrt`'s is the reverse, which is why all three runs show 21/29 with different miss sets. Nothing fails because
  an option was missing.

### 5.4 Coverage of the shape stage (offline, all 41 programs, no Jev)

Token-level classification of the 36 one-line replacement fixes (python `tokenize` and the hand-written tokenizer
agree on every line):

| Fix class | n | Share | What D3 must offer |
| --- | --- | --- | --- |
| Same shape, one identifier/number substituted | 7 | 19 % | buggy shape with one typed hole |
| Same shape modulo an operator change | 4 | 11 % | buggy shape with an operator hole |
| Longer: a fragment inserted (`[1:]`, `+ 1`, `- 1`, `or not coins`, `** 2`, `rest_subsets +`) | 16 | 44 % | buggy shape + one fragment production at a gap (the fragment table) |
| Shorter: a fragment deleted (`1 +`, `flatten(...)` → `x`) | 5 | 14 % | buggy shape with a fragment removed |
| Reshaped, same length (argument swap `a % b, b` → `b, a % b`; `^=` → `&=` counts as operator) | 4 | 11 % | permutation productions |
| Inserted line (`shunting_yard`, `wrap`, `depth_first_search`, `reverse_linked_list`) | 4 | – | statement templates (D3 (e)) |
| Multi-line (`node`) | 1 | – | out of scope for one line |

Slots per fixed line: mean 5.3, median 5, max 12; 26/36 have ≤ 6 and 35/36 ≤ 10. Donor shapes (another line in
the same file with the same abstract shape) matched the fixed line in only 1/29 cases, so on this benchmark
the shape stage is about the buggy line plus a fragment table, not donors; on a large repository the
plastic-surgery hypothesis will move that number.

## 6. What this means for the design

1. **Build lines as slot sequences over code-built option sets; it works.** With the shape known, a beam of 3–5
   over Jev Choices reconstructs 76–83 % of QuixBugs fix lines from scratch and 92 % when only the changed slots
   are open, for ~$0.0006–0.0008 and ~1.3 s of Jev time per line (5.4 requests × $0.00012–0.00015 × ~240 ms). Coverage of the option sets was 100 %, so the
   input-dependent grammar (identifiers with roles, attributes seen, literals from tests, 24 operators) is the
   right proposal mechanism; nothing needs to be generated.
2. **Spend the next experiment on D3 (shape), not on slots.** The pilot gave the shape away. §5.4 says 30 % of
   fixes are a hole in the buggy shape, 44 % are the buggy shape plus one fragment at a gap, 14 % minus a fragment;
   a fragment table of ~20 productions plus "hole at anchor" covers ≈ 90 % of one-line fixes. The measurement to
   make: Choice over ≤ 255 concrete sketches (buggy shape × {hole at anchor, fragment at gap, deletion}), top-1 and
   top-3 against the gold shape, then S2 on the chosen shape end to end. Since S2 needs 1.7 requests and D1–D3 one,
   an end-to-end attempt is ~3 requests, well inside the 30-decision budget with retries.
3. **Ask the edit class as its own Choice, before the anchor.** Jev anchors the edit site 29/29 but says
   "substitute" when the fix is an insertion; an escape row cannot carry that distinction. D1 with defined
   options and examples ("insert_fragment: the line needs an extra term, index, slice or condition; e.g. `mid` →
   `mid + 1`") is the fix, and it should be paired with per-class Nouls (REPORT §10: Choice is relative, Noul is
   absolute).
4. **Beam of 3 by default, 5 when the line has ≥ 6 slots; never 1.** Greedy loses a third of the S1 lines (14 → 22) and a fifth of the S2 lines (18 → 23); B = 3
   costs 36 % more per request than B = 1 with no latency change; B = 5 adds 2 S1 lines (22 → 24, S2 unchanged) at 27 % more,
   which is within run-to-run noise. Verify all B
   completed lines with the tests, in rank order, and stop at the first pass.
5. **Tests decide, then cluster.** Three of the passing lines were non-gold; two equivalent (`next_permutation`,
   `max_sublist_sum`), one over-fitted (`possible_change` at B = 5). Run
   passing candidates on generated inputs and cluster by output before committing; ask Jev to pick a cluster only
   when clusters disagree.
6. **No parser dependency.** The 25-line tokenizer is exact on the corpus and the scope scan is regular; use
   `python3 -c 'compile(...)'` as the validity gate between steps and `ast` only as an optional enrichment on
   large files. web-tree-sitter would add a dependency and a `.wasm` build for capabilities this stage does not use.
7. **Known limits to carry into the ladder.** Long lines (12 slots) and float-heavy specs (`sqrt`) fail; mid-band
   noise flips 1–2 lines between runs (`possible_change`, `kheapsort`); the `kind` question is untested on inserted
   lines; and everything here is QuixBugs-sized state (2–3k tokens). On a SWE-bench file the same sequence costs
   ~5× more per request and ~10 % more latency (REPORT §5), which is still cents and seconds per line, so the cost
   model in §4 holds; the accuracy model does not transfer until the shape stage and the anchor are measured on
   real repositories (ladder step 3–4 in `docs/JEV-ONLY.md`).

## Verification (2026-09-20)

Adversarial check by a second agent. Scripts used are under `experiments/lit-synthesis/verify/` (`slot-probe-verify.mts`, a
copy of the pilot that writes to `verify/` instead of `results/`; `taxonomy-check.py`; `tokenizer-check.mts` +
`tokenizer-check.py`). Live spend for the check: **$0.0049** (one 8-program run at B = 3, 44 requests). `report-tables.mts`
was patched (see item 1) and re-run; every other table in §5.2 was regenerated from the raw JSON byte-for-byte.

| Claim | Method | Result |
| --- | --- | --- |
| Run summaries (29 programs, 227 requests, $0.0198 / $0.0270 / $0.0342, p50 248 / 234 / 248 ms) | read `summary` in `results/slot-probe-b{1,3,5}.json`; recount requests as 1 + Σ S1 steps + Σ S2 steps | **Confirmed**: 227 = 227 in all three runs; cost per request $0.000087 / $0.000119 / $0.000151. Latency p50/p90 exist only as summary numbers (per-request latencies were not saved), so they are taken as reported. |
| 156 slots, 156 covered, cloze 142/144/144, prefix 144/145/141, MRR 0.95–0.96 | recomputed from `results[].slots` | **Confirmed** exactly. |
| Per-class counts (ident 93, attr 1, oper 38, num 24) and top-1 | recomputed | **Confirmed**. Text ranges corrected: operators are 34–37/38 (not 35–37), numbers 23/24 cloze at B = 1; identifier misses are rank 2–3 in prefix mode but one per run is rank 4 in cloze mode. |
| S1 pass 14/22/24, pass@1 14/18/20, truth in beam 12/21/22; S2 pass 18/23/23, pass@1 18/19/19, truth 18/23/23 | recomputed from `s1`/`s2.passRank`/`truthRank` | **Confirmed** exactly. |
| S2 mean holes 1.8 | recomputed | **Corrected**: 42 holes / 25 lines = 1.68 → 1.7 (§3.3, §5.1, §5.3, §6.2 updated). |
| Per-program `Requests` and `Cost` columns | sum of the raw per-program `requests` = 1,283 vs 227 actual | **Corrected**. `slot-probe.mts` runs 6 programs concurrently and computes per-program cost/requests as differences of *shared* counters, so the raw fields include other programs' traffic (e.g. `subsequences`: 5 requests recorded, 1 actual). The table now derives requests from the saved beam records (1 + S1 steps + S2 steps) and estimates cost as requests × $0.00012; `report-tables.mts` was changed accordingly. The run-level totals were never affected. |
| Non-gold passing lines: "two, one equivalent, one over-fitted" | listed every `passRank > 0 && passRank != truthRank` | **Corrected**: three distinct lines. `max_sublist_sum` (`max(0, x + max_ending_here)`, equivalent, passes at rank 1 in all runs with the gold at rank 2) had been omitted; `next_permutation` (equivalent) and `possible_change` at B = 5 (over-fitted) as stated. |
| Oracle: "all tests for 27 programs; knapsack and levenshtein lose one slow test" | `goldPassesAll` + rerunning gold `sqrt` against its JSON | **Corrected**: 26 programs are complete; `sqrt` also loses 2 of 7 tests, because the gold's Newton result differs from the JSON expectation by 2 × 10⁻⁶ relative and the runner's tolerance is 1e-6, not because of the alarm. The "oracle is sound" sentence was circular (the oracle is defined as the tests the gold passes) and was reworded. |
| `wrong_token` 21/29 in every run; the 8 misses at B = 3 all pick the token before the insertion point (7) or an equivalent operator (1) | listed misses per run | **Confirmed** for B = 3. Note the miss set differs by run: B = 1 misses `kheapsort` instead of `sqrt`. |
| `kind` 29/29; shape in donors 1/29 | recomputed | **Confirmed**. |
| Beam-width text: "B = 3 costs 30 % more per request than B = 1", "B = 5 adds 3 lines" | from summaries | **Corrected**: 36 % more; B = 5 adds 2 S1 lines (22 → 24) and 0 S2 lines, within noise. §6.1 cost/latency per line adjusted to ~$0.0006–0.0008 and ~1.3 s (5.4 × $0.00012–0.00015, 5.4 × 240 ms). |
| §4 table row "40 QuixBugs programs … 217–227 requests", "231–237 ms p50" | compare with §5.2 | **Corrected** to 29 programs, 227 requests, 234–248 ms. |
| Fix-shape taxonomy (§5.4): 36 one-line replacements = 16 inserted + 5 deleted + 15 same-length; 4 inserted lines; 1 multi-line; slots median 5, max 12, 35/36 ≤ 10 | `taxonomy-check.py` over all 41 programs (comment-only line differences ignored, as the pilot does) | **Confirmed**: 16 / 5 / 15 / 4 / 1; 29 one-line replacements have JSON tests. The 15 same-length fixes split 7 / 4 / 4 in the file versus 8 substitutions / 7 reshaped in the recount, which classes every operator change as a reshape; the split is definitional, the total is not. Slots: mean 5.4, median 5, max 12, 35/36 ≤ 10, **25/36** ≤ 6 (file says 26/36; the difference is whether `in` in a `for` header counts as an operator slot). |
| Tokenizer agrees with CPython `tokenize` on 413/413 tokenizable lines of 440 | `tokenizer-check.mts` (same regex) + `tokenizer-check.py` | **Confirmed**: 440 lines, 413 CPython-tokenizable, 413 agree, 0 disagree, 27 CPython failures (bracket fragments). |
| `node_modules` has 84 packages and no Python parser | `ls node_modules` | 84 top-level entries (60 packages + 24 scoped) — **confirmed** in spirit; no tree-sitter or Python grammar present. |
| Literature rows have URLs and fetch dates | re-fetched rows 7 (Synchromesh, arXiv 2201.11227), 12 (Write-Execute-Assess, arXiv 1906.04604) and 4 (Sketch via Semantic Scholar DOI) | **Confirmed**: titles, authors, and the quoted phrases ("completes the sketch to behave like the specification", "finite programs", AES; REPL "immediately executes partially written programs", policy + value, SMC; CSD + TST, SQL / Vega-Lite / SMCalFlow) are all present in the fetched abstracts. Rows 1, 4, 10, 14 carry details flagged "from memory" (12× speed-up, AES "in about an hour", AlphaCode's ~1M samples, GumTree's phases); these remain **unverified** here. |
| Question hygiene (REPORT §7, §10, §11, §14) | read `slot-probe.mts` and `src/jev/questions.ts` | Every question is built with `choice()`, so `none_of_these` is always present (plus `a_token_is_missing` on `wrong_token`); keys are semantic (`name_<ident>`, `op_plus`, `num_2`, `attr_append`, `return_statement`); descriptions are backticked; targets are named by path (`partial_lines.cloze_3`, `candidates.second`); nothing asks Jev to count or compute (token indices appear only as labels in descriptions). One weak spot: punctuation tokens get the key `tokN_x` because the sanitizer strips symbols (`)` → `x`), so those options lean entirely on their description; harmless per REPORT §11 but worth fixing. |
| Live reproduction | `slot-probe-verify.mts 8 3` on the first 8 programs (bitcount … hanoi) | **Reproduces**: 44 requests, $0.0049, p50 210 ms; 28/28 slots covered; cloze 25/28, prefix 26/28 (saved B = 3 run on the same 8: 25 and 27); `wrong_token` 7/8 with the same miss (`find_in_sorted`); S2 6/6 pass; S1 7/8 pass with two flips versus the saved run (`bucketsort` now passes, `hanoi` now fails), which is the mid-band noise §5.3 describes. |
| Total topic spend ~$0.17 including ~$0.06 of development runs | sum of the three saved runs = $0.081 | The three reported runs are confirmed at $0.081; the development-run spend is **not recoverable** from any saved artefact, so the $0.17 total is taken as reported (it is in any case under the cap). |

Conclusions in §6 survive the corrections: the headline percentages (S1 76–83 % at B = 3–5, S2 92 %, slot top-1 ~90 %,
100 % option coverage, flat latency across B) are exactly reproduced from the raw output and partially re-observed live.
Two conclusions are softened: B = 5 over B = 3 is a 2-line (not 3-line) gain inside run-to-run noise, so "B = 5 for lines
with ≥ 6 slots" is a reasonable default but not demonstrated; and the "tests decide, then cluster" recommendation is
*stronger* than stated, since 2 of 22 passing lines at B = 3 and 3 of 24 at B = 5 were non-gold (one of them over-fitted to
the tests). The caveat that the shape (D3) and localisation stages were given away stands and is the main reason the
76–92 % figures are conditional.

**Verdict: corrected** (aggregate numbers sound; per-program request/cost columns, S2 hole count, oracle description,
non-gold count, and several text ranges fixed; no headline number changed).
