## Run summary

| Requests | Cost (USD) | Jev latency p50 / p90 (ms) | Max input tokens in one request | Errors |
| --- | --- | --- | --- | --- |
| 332 | 0.0432 | 205 / 296 | 13,389 | 0 |

Per question: requests, tokens per request (p50 / max), cost, latency p50.

| Question | Variant | n | input tokens p50 | input tokens max | cost (USD) | latency p50 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| Q1 | ps | 30 | 2,745 | 4,081 | 0.0037 | 205 |
| Q1 | ps_hints | 30 | 2,985 | 5,491 | 0.0040 | 204 |
| Q2 | ps | 37 | 2,508 | 12,562 | 0.0051 | 191 |
| Q2 | ps_hints | 37 | 2,549 | 12,607 | 0.0055 | 193 |
| Q3 | outline | 33 | 4,534 | 13,389 | 0.0077 | 216 |
| Q3 | paths | 33 | 3,504 | 8,758 | 0.0058 | 227 |
| Q4 | names | 66 | 1,594 | 5,450 | 0.0052 | 194 |
| Q4 | names_testcode | 66 | 2,097 | 6,120 | 0.0062 | 209 |

## Q1 change kind

| Variant `ps` | n | Choice top-1 = primary label | Choice top-1 in {primary, also_ok} | primary in Choice top-2 | MRR (primary) | Noul(primary) > 0.5 | any Noul > 0.5 is an accepted label | mean kinds with Noul > 0.5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | 30 | 16/30 (53%) | 22/30 (73%) | 21/30 (70%) | 0.70 | 20/30 (67%) | 25/30 (83%) | 2.2 |

| Variant `ps_hints` | n | Choice top-1 = primary label | Choice top-1 in {primary, also_ok} | primary in Choice top-2 | MRR (primary) | Noul(primary) > 0.5 | any Noul > 0.5 is an accepted label | mean kinds with Noul > 0.5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | 30 | 17/30 (57%) | 21/30 (70%) | 20/30 (67%) | 0.70 | 17/30 (57%) | 25/30 (83%) | 2.1 |

Confusion (rows: my primary label, columns: Jev top-1, variant `ps`):

| label \ jev | fwv | agoc | aboc | ccoa | anfo | cs | cmof | com | rwbc | not |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fix_wrong_value | 2 | 2 | 2 | 2 |  |  |  | 1 |  |  |
| add_guard_or_check |  | 5 |  |  |  |  |  |  |  |  |
| add_branch_or_case | 1 | 1 | 3 | 1 |  |  |  |  |  |  |
| change_call_or_arguments |  |  | 1 | 3 |  | 1 |  |  |  |  |
| add_new_function_or_method |  |  |  | 1 |  |  |  |  |  |  |
| change_signature |  |  |  | 1 |  | 2 |  |  |  |  |
| none_of_these |  |  |  |  |  |  |  |  |  | 1 |

Abbreviations: fwv = fix_wrong_value, agoc = add_guard_or_check, aboc = add_branch_or_case, ccoa = change_call_or_arguments, anfo = add_new_function_or_method, cs = change_signature, cmof = change_message_or_formatting, com = config_or_metadata, rwbc = refactor_without_behaviour_change, not = none_of_these.

Per instance (variant `ps`; `+h` column is the top-1 with hints):

| Instance | My label (also ok) | Jev top-1 (p) | p(label) | Noul(label) | Nouls > 0.5 | top-1 +h |
| --- | --- | --- | --- | --- | --- | --- |
| sympy-12096 | change_call_or_arguments (fix_wrong_value) | change_call_or_arguments (0.96) | 0.96 | 0.87 | change_call_or_arguments | change_call_or_arguments |
| sympy-15345 | add_branch_or_case (config_or_metadata, add_new_function_or_method) | change_call_or_arguments (0.36) x | 0.17 | 0.51 | fix_wrong_value, add_branch_or_case, change_call_or_arguments, change_message_or_formatting | add_branch_or_case |
| sympy-17139 | add_guard_or_check (-) | add_guard_or_check (0.86) | 0.86 | 0.82 | add_guard_or_check, add_branch_or_case | add_guard_or_check |
| sympy-19954 | fix_wrong_value (none_of_these, refactor_without_behaviour_change) | add_guard_or_check (0.49) x | 0.29 | 0.31 | add_guard_or_check | add_guard_or_check x |
| sympy-11618 | add_branch_or_case (add_guard_or_check) | fix_wrong_value (0.40) x | 0.16 | 0.24 | - | fix_wrong_value x |
| sympy-13798 | add_branch_or_case (add_guard_or_check) | add_branch_or_case (0.56) | 0.56 | 0.57 | add_branch_or_case | add_branch_or_case |
| sympy-16792 | change_call_or_arguments (add_branch_or_case) | change_signature (0.39) x | 0.07 | 0.41 | add_branch_or_case, change_signature | change_signature x |
| sympy-20428 | fix_wrong_value (change_call_or_arguments) | change_call_or_arguments (0.36) ~ | 0.20 | 0.44 | add_guard_or_check, add_branch_or_case, change_call_or_arguments | change_call_or_arguments ~ |
| sympy-22080 | add_branch_or_case (config_or_metadata, fix_wrong_value) | add_guard_or_check (0.36) x | 0.31 | 0.62 | add_guard_or_check, add_branch_or_case, change_call_or_arguments | add_guard_or_check x |
| sympy-12489 | change_call_or_arguments (fix_wrong_value, refactor_without_behaviour_change, change_signature) | change_call_or_arguments (0.85) | 0.85 | 0.84 | change_call_or_arguments | change_call_or_arguments |
| django-14787 | change_call_or_arguments (fix_wrong_value) | add_branch_or_case (0.42) x | 0.34 | 0.31 | add_branch_or_case | add_branch_or_case x |
| django-15315 | fix_wrong_value (refactor_without_behaviour_change) | fix_wrong_value (0.91) | 0.91 | 0.66 | fix_wrong_value | fix_wrong_value |
| django-15572 | add_guard_or_check (-) | add_guard_or_check (0.94) | 0.94 | 0.88 | add_guard_or_check, add_branch_or_case, change_call_or_arguments | add_guard_or_check |
| django-16100 | none_of_these (add_guard_or_check) | none_of_these (1.00) | 1.00 | nan | - | none_of_these |
| django-14725 | change_signature (add_branch_or_case) | change_signature (0.74) | 0.74 | 0.74 | add_guard_or_check, add_branch_or_case, add_new_function_or_method, change_signature | change_signature |
| django-15103 | change_signature (add_branch_or_case) | change_signature (1.00) | 1.00 | 0.95 | add_guard_or_check, add_branch_or_case, change_call_or_arguments, change_signature | change_signature |
| django-15375 | fix_wrong_value (change_call_or_arguments, none_of_these) | add_branch_or_case (0.43) x | 0.11 | 0.24 | add_branch_or_case, change_call_or_arguments | fix_wrong_value |
| django-15563 | fix_wrong_value (add_branch_or_case) | fix_wrong_value (0.60) | 0.60 | 0.53 | fix_wrong_value, add_branch_or_case, change_call_or_arguments | change_signature x |
| django-15916 | fix_wrong_value (refactor_without_behaviour_change, change_call_or_arguments) | change_call_or_arguments (0.45) ~ | 0.22 | 0.51 | fix_wrong_value, add_guard_or_check, add_branch_or_case, change_call_or_arguments | change_call_or_arguments ~ |
| django-15128 | change_signature (change_call_or_arguments, add_guard_or_check) | change_call_or_arguments (0.40) ~ | 0.28 | 0.57 | add_branch_or_case, change_call_or_arguments, change_signature | change_call_or_arguments ~ |
| pytest-10081 | add_guard_or_check (fix_wrong_value) | add_guard_or_check (0.81) | 0.81 | 0.79 | add_guard_or_check, add_branch_or_case, change_call_or_arguments | add_guard_or_check |
| pytest-7205 | change_call_or_arguments (change_message_or_formatting) | change_call_or_arguments (0.94) | 0.94 | 0.92 | change_call_or_arguments, change_message_or_formatting | change_call_or_arguments |
| pytest-10051 | add_new_function_or_method (change_call_or_arguments) | change_call_or_arguments (0.48) ~ | 0.00 | 0.11 | - | fix_wrong_value x |
| pytest-7324 | fix_wrong_value (none_of_these, add_guard_or_check) | add_guard_or_check (0.45) ~ | 0.17 | 0.35 | add_guard_or_check, add_branch_or_case, change_call_or_arguments | add_new_function_or_method x |
| pytest-10356 | add_branch_or_case (change_signature) | add_branch_or_case (0.48) | 0.48 | 0.54 | add_branch_or_case, change_call_or_arguments, add_new_function_or_method | add_branch_or_case |
| pylint-4970 | add_guard_or_check (-) | add_guard_or_check (0.92) | 0.92 | 0.88 | add_guard_or_check, add_branch_or_case | add_guard_or_check |
| pylint-4604 | add_branch_or_case (add_guard_or_check) | add_branch_or_case (0.53) | 0.53 | 0.71 | add_guard_or_check, add_branch_or_case | add_branch_or_case |
| pylint-6386 | fix_wrong_value (config_or_metadata, add_branch_or_case) | config_or_metadata (0.95) ~ | 0.01 | 0.58 | fix_wrong_value, change_call_or_arguments, config_or_metadata | config_or_metadata ~ |
| requests-1142 | add_guard_or_check (add_branch_or_case) | add_guard_or_check (0.67) | 0.67 | 0.76 | add_guard_or_check, add_branch_or_case | add_guard_or_check |
| requests-2931 | fix_wrong_value (add_guard_or_check) | add_branch_or_case (0.46) x | 0.04 | 0.49 | add_guard_or_check, add_branch_or_case, change_call_or_arguments | add_branch_or_case x |

## Q2 function-level localisation in the gold file

| Variant `ps` | n (gold files) | top-1 (any touched fn) | top-5 | MRR | top-1 = primary touched fn | median options | escape mass max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | 37 | 19/37 (51%) | 35/37 (95%) | 0.70 | 12/37 (32%) | 41 | 0.69 |

| Variant `ps_hints` | n (gold files) | top-1 (any touched fn) | top-5 | MRR | top-1 = primary touched fn | median options | escape mass max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | 37 | 25/37 (68%) | 35/37 (95%) | 0.80 | 18/37 (49%) | 41 | 0.71 |

Per gold file (variant `ps`):

| Instance | File | options | touched (truth) | Jev top-1 (p) | rank | p(primary) | rank +h |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sympy-12096 | sympy/core/function.py | 93 | function_eval_evalf | function_eval_evalf (1.00) | 1 | 1.00 | 1 |
| sympy-15345 | sympy/printing/mathematica.py | 14 | module_level_code_outside_any_function, mcodeprinter_print_function | mcodeprinter_print_function (0.80) | 1 | 0.03 | 1 |
| sympy-17139 | sympy/simplify/fu.py | 37 | tr56 | tr56 (0.72) | 1 | 0.72 | 1 |
| sympy-19954 | sympy/combinatorics/perm_groups.py | 107 | permutationgroup_minimal_blocks | permutationgroup_minimal_blocks (0.96) | 1 | 0.96 | 1 |
| sympy-11618 | sympy/geometry/point.py | 52 | point_distance | point_distance (0.98) | 1 | 0.98 | 1 |
| sympy-13798 | sympy/printing/latex.py | 221 | latexprinter_init | latexprinter_print_mul (0.58) | 2 | 0.33 | 1 |
| sympy-16792 | sympy/utilities/codegen.py | 92 | codegen_routine | ccodegen_declare_arguments (0.51) | 2 | 0.19 | 2 |
| sympy-20428 | sympy/polys/domains/expressiondomain.py | 50 | expressiondomain_expression_bool | none_of_these (0.57) | 2 | 0.15 | 2 |
| sympy-22080 | sympy/printing/codeprinter.py | 46 | module_level_code_outside_any_function, codeprinter_print_mul | codeprinter_print_mul (0.52) | 1 | 0.01 | 1 |
| sympy-22080 | sympy/printing/precedence.py | 11 | module_level_code_outside_any_function | none_of_these (0.62) | 4 | 0.06 | 1 |
| sympy-12489 | sympy/combinatorics/permutations.py | 83 | module_level_code_outside_any_function, permutation_new, permutation_af_new (+24) | permutation_af_new (0.77) | 1 | 0.22 | 1 |
| django-14787 | django/utils/decorators.py | 12 | multi_decorate | method_decorator (0.59) | 3 | 0.01 | 3 |
| django-15315 | django/db/models/fields/__init__.py | 230 | field_hash | field_hash (1.00) | 1 | 1.00 | 1 |
| django-15572 | django/template/autoreload.py | 6 | get_template_directories | template_changed (0.60) | 2 | 0.37 | 2 |
| django-16100 | django/contrib/admin/options.py | 111 | modeladmin_changelist_view | modeladmin_changelist_view (1.00) | 1 | 1.00 | 1 |
| django-14725 | django/forms/models.py | 75 | basemodelformset_save, modelformset_factory, inlineformset_factory | basemodelformset_init (0.30) | 2 | 0.30 | 1 |
| django-15103 | django/template/defaultfilters.py | 61 | json_script | json_script (1.00) | 1 | 1.00 | 1 |
| django-15103 | django/utils/html.py | 26 | json_script | json_script (1.00) | 1 | 1.00 | 1 |
| django-15375 | django/db/models/aggregates.py | 16 | aggregate_resolve_expression | aggregate_as_sql (0.65) | 2 | 0.20 | 1 |
| django-15563 | django/db/models/sql/compiler.py | 47 | sqlupdatecompiler_pre_sql_setup | sqlupdatecompiler_as_sql (0.56) | 2 | 0.38 | 1 |
| django-15563 | django/db/models/sql/subqueries.py | 15 | updatequery_get_related_updates | updatequery_setup_query (0.55) | 4 | 0.10 | 1 |
| django-15916 | django/forms/models.py | 75 | modelformoptions_init, modelformmetaclass_new, modelform_factory | modelform_factory (0.90) | 1 | 0.04 | 1 |
| django-15128 | django/db/models/sql/query.py | 112 | query_combine, query_change_aliases, query_bump_prefix | query_combine (0.29) | 1 | 0.01 | 1 |
| pytest-10081 | src/_pytest/unittest.py | 24 | testcasefunction_runtest | testcasefunction_teardown (0.18) | 7 | 0.06 | 6 |
| pytest-7205 | src/_pytest/setuponly.py | 7 | module_level_code_outside_any_function, show_fixture_action | show_fixture_action (1.00) | 1 | 0.00 | 1 |
| pytest-10051 | src/_pytest/logging.py | 57 | module_level_code_outside_any_function, logcapturefixture_clear, logcapturehandler_reset | logcapturefixture_clear (0.83) | 1 | 0.00 | 1 |
| pytest-7324 | src/_pytest/mark/expression.py | 19 | module_level_code_outside_any_function, not_expr, matcheradapter_getitem (+1) | expression_compile (0.49) | 3 | 0.11 | 2 |
| pytest-10356 | src/_pytest/mark/structures.py | 35 | get_unpacked_marks, store_mark | get_unpacked_marks (0.88) | 1 | 0.88 | 1 |
| pylint-4970 | pylint/checkers/similar.py | 51 | similar_run | similarchecker_set_option (0.52) | 3 | 0.11 | 4 |
| pylint-4604 | pylint/checkers/variables.py | 78 | variableschecker_store_type_annotation_node | variableschecker_store_type_annotation_names (0.43) | 3 | 0.08 | 3 |
| pylint-4604 | pylint/constants.py | 2 | module_level_code_outside_any_function | none_of_these (0.69) | 2 | 0.31 | 2 |
| pylint-6386 | pylint/config/argument.py | 18 | callableargument_init | storetrueargument_init (0.39) | 18 | 0.00 | 18 |
| pylint-6386 | pylint/config/arguments_manager.py | 31 | argumentsmanager_add_parser_option | argumentsmanager_add_parser_option (0.33) | 1 | 0.33 | 1 |
| pylint-6386 | pylint/config/utils.py | 11 | convert_option_to_argument, module_level_code_outside_any_function, preprocess_options | set_verbose_mode (0.42) | 2 | 0.08 | 2 |
| pylint-6386 | pylint/lint/base_options.py | 4 | make_run_options | make_run_options (0.83) | 1 | 0.83 | 1 |
| requests-1142 | requests/models.py | 34 | preparedrequest_prepare_content_length | preparedrequest_prepare_content_length (0.75) | 1 | 0.75 | 1 |
| requests-2931 | requests/models.py | 41 | requestencodingmixin_encode_params, preparedrequest_prepare_url | preparedrequest_prepare_body (0.86) | 2 | 0.11 | 2 |

## Q3 file-level Nouls over the package

| Variant `outline` | n (packages) | files p50 | micro P/R at 0.5 | micro P/R at 0.7 | gold ranked first | exact set at 0.5 | MRR (first gold) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | 33 | 16 | P 28/30 = 0.93, R 28/37 = 0.76 | P 24/25 = 0.96, R 24/37 = 0.65 | 31/33 (94%) | 26/33 (79%) | 0.96 |

| Variant `paths` | n (packages) | files p50 | micro P/R at 0.5 | micro P/R at 0.7 | gold ranked first | exact set at 0.5 | MRR (first gold) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | 33 | 16 | P 27/32 = 0.84, R 27/37 = 0.73 | P 23/25 = 0.92, R 23/37 = 0.62 | 28/33 (85%) | 25/33 (76%) | 0.90 |

Per package (variant `outline`; `paths` gives the same measures without symbol outlines):

| Instance | Package | files | gold files: p | selected at 0.5 (tp) | at 0.7 (tp) | rank of first gold | max p non-gold | paths: rank / sel at 0.5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sympy-12096 | sympy/core | 31 | function.py 0.90 | 1 (1) | 1 (1) | 1 | 0.10 | 1 / 1 |
| sympy-15345 | sympy/printing | 30 | mathematica.py 0.84 | 1 (1) | 1 (1) | 1 | 0.06 | 1 / 1 |
| sympy-17139 | sympy/simplify | 16 | fu.py 0.89 | 1 (1) | 1 (1) | 1 | 0.11 | 1 / 1 |
| sympy-19954 | sympy/combinatorics | 22 | perm_groups.py 0.91 | 1 (1) | 1 (1) | 1 | 0.06 | 1 / 1 |
| sympy-11618 | sympy/geometry | 12 | point.py 0.83 | 1 (1) | 1 (1) | 1 | 0.16 | 1 / 1 |
| sympy-13798 | sympy/printing | 30 | latex.py 0.90 | 1 (1) | 1 (1) | 1 | 0.08 | 1 / 1 |
| sympy-16792 | sympy/utilities | 20 | codegen.py 0.79 | 1 (1) | 1 (1) | 1 | 0.22 | 1 / 1 |
| sympy-20428 | sympy/polys/domains | 31 | expressiondomain.py 0.16 | 0 (0) | 0 (0) | 1 | 0.08 | 1 / 0 |
| sympy-22080 | sympy/printing | 37 | codeprinter.py 0.24, precedence.py 0.11 | 0 (0) | 0 (0) | 4 | 0.42 | 2 / 0 |
| sympy-12489 | sympy/combinatorics | 16 | permutations.py 0.91 | 1 (1) | 1 (1) | 1 | 0.04 | 1 / 1 |
| django-14787 | django/utils | 43 | decorators.py 0.90 | 1 (1) | 1 (1) | 1 | 0.05 | 1 / 1 |
| django-15315 | django/db/models/fields | 9 | __init__.py 0.94 | 1 (1) | 1 (1) | 1 | 0.06 | 1 / 1 |
| django-15572 | django/template | 15 | autoreload.py 0.85 | 1 (1) | 1 (1) | 1 | 0.12 | 1 / 1 |
| django-16100 | django/contrib/admin | 15 | options.py 0.64 | 1 (1) | 0 (0) | 1 | 0.26 | 1 / 1 |
| django-14725 | django/forms | 9 | models.py 0.74 | 2 (1) | 2 (1) | 1 | 0.71 | 2 / 2 |
| django-15103 | django/template | 15 | defaultfilters.py 0.90 | 1 (1) | 1 (1) | 1 | 0.06 | 6 / 1 |
| django-15103 | django/utils | 43 | html.py 0.92 | 1 (1) | 1 (1) | 1 | 0.04 | 1 / 1 |
| django-15375 | django/db/models | 16 | aggregates.py 0.73 | 1 (1) | 1 (1) | 1 | 0.25 | 1 / 1 |
| django-15563 | django/db/models/sql | 7 | compiler.py 0.45, subqueries.py 0.52 | 1 (1) | 0 (0) | 1 | 0.43 | 2 / 1 |
| django-15916 | django/forms | 9 | models.py 0.93 | 1 (1) | 1 (1) | 1 | 0.08 | 1 / 1 |
| django-15128 | django/db/models/sql | 7 | query.py 0.90 | 1 (1) | 1 (1) | 1 | 0.07 | 1 / 1 |
| pytest-10081 | src/_pytest | 45 | unittest.py 0.68 | 1 (1) | 0 (0) | 1 | 0.35 | 1 / 1 |
| pytest-7205 | src/_pytest | 39 | setuponly.py 0.91 | 1 (1) | 1 (1) | 1 | 0.08 | 1 / 1 |
| pytest-10051 | src/_pytest | 45 | logging.py 0.95 | 1 (1) | 1 (1) | 1 | 0.03 | 1 / 1 |
| pytest-7324 | src/_pytest/mark | 4 | expression.py 0.76 | 1 (1) | 1 (1) | 1 | 0.18 | 1 / 1 |
| pytest-10356 | src/_pytest/mark | 3 | structures.py 0.67 | 1 (1) | 0 (0) | 1 | 0.17 | 1 / 1 |
| pylint-4970 | pylint/checkers | 22 | similar.py 0.82 | 1 (1) | 1 (1) | 1 | 0.06 | 1 / 1 |
| pylint-4604 | pylint | 8 | constants.py 0.07 | 0 (0) | 0 (0) | 1 | 0.05 | 1 / 0 |
| pylint-4604 | pylint/checkers | 23 | variables.py 0.75 | 1 (1) | 1 (1) | 1 | 0.40 | 1 / 2 |
| pylint-6386 | pylint/config | 18 | argument.py 0.29, arguments_manager.py 0.09, utils.py 0.32 | 0 (0) | 0 (0) | 1 | 0.27 | 6 / 1 |
| pylint-6386 | pylint/lint | 8 | base_options.py 0.81 | 1 (1) | 1 (1) | 1 | 0.13 | 1 / 1 |
| requests-1142 | requests | 14 | models.py 0.71 | 1 (1) | 1 (1) | 1 | 0.15 | 1 / 1 |
| requests-2931 | requests | 14 | models.py 0.38 | 1 (0) | 0 (0) | 2 | 0.66 | 1 / 1 |

## Q4 line-level localisation inside the gold function

| Variant `names` | n (functions) | top-1 within +-3 | top-5 within +-3 | top-1 exact | MRR (+-3) | median lines | n (instances, primary fn) | top-1 +-3 | top-5 +-3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | 66 | 40/66 (61%) | 62/66 (94%) | 25/66 (38%) | 0.76 | 25 | 29 | 22/29 (76%) | 28/29 (97%) |

| Variant `names_testcode` | n (functions) | top-1 within +-3 | top-5 within +-3 | top-1 exact | MRR (+-3) | median lines | n (instances, primary fn) | top-1 +-3 | top-5 +-3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | 66 | 42/66 (64%) | 62/66 (94%) | 27/66 (41%) | 0.78 | 25 | 29 | 24/29 (83%) | 28/29 (97%) |

Per touched function (variant `names`; last column: rank within +-3 when the added test code is in the state):

| Instance | Function | lines | truth lines | Jev top-1 (p) | rank +-3 | rank exact | +testcode rank +-3 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sympy-12096 | Function._eval_evalf | 45 | 510 | 510 (0.93) | 1 | 1 | 1 |
| sympy-17139 | _TR56 | 49 | 502 | 504 (0.96) | 1 | 30 | 1 |
| sympy-19954 | PermutationGroup.minimal_blocks | 76 | 2197, 2201, 2202, 2208 | 2201 (0.60) | 1 | 1 | 1 |
| sympy-11618 | Point.distance | 24 | 268 | 269 (0.83) | 1 | 24 | 1 |
| sympy-13798 | LatexPrinter.__init__ | 22 | 158, 159, 160, 161 ... | 160 (0.65) | 1 | 1 | 1 |
| sympy-16792 | CodeGen.routine | 143 | 697, 706, 708, 709 ... | 643 (0.41) | 2 | 11 | 2 |
| sympy-20428 | ExpressionDomain.Expression.__bool__ | 2 | 123 | 123 (0.66) | 1 | 1 | 1 |
| sympy-22080 | CodePrinter._print_Mul | 40 | 490 | 486 (0.24) | 19 | 33 | 20 |
| sympy-12489 | Permutation.__iter__ | 10 | 1526 | 1524 (0.11) | 1 | >all | 1 |
| sympy-12489 | Permutation.__mul__ | 48 | 1245, 1246 | 1303 (0.85) | 2 | 3 | 3 |
| sympy-12489 | Permutation.__new__ | 107 | 860, 862, 865, 868 ... | 860 (0.41) | 1 | 1 | 1 |
| sympy-12489 | Permutation.__pow__ | 18 | 1344 | 1344 (0.72) | 1 | 1 | 1 |
| sympy-12489 | Permutation.__rmul__ | 3 | 1242 | 1242 (0.58) | 1 | 1 | 1 |
| sympy-12489 | Permutation.__rxor__ | 14 | 1348 | 1358 (0.28) | 2 | >all | 2 |
| sympy-12489 | Permutation.__sub__ | 7 | 1166 | 1174 (0.17) | 2 | 2 | 2 |
| sympy-12489 | Permutation._af_new | 20 | 928, 929, 931, 932 | 947 (0.74) | 2 | 2 | 2 |
| sympy-12489 | Permutation.commutes_with | 17 | 1307 | 1305 (0.05) | 1 | 5 | 1 |
| sympy-12489 | Permutation.from_inversion_vector | 22 | 2714, 2717 | 2737 (0.87) | 2 | 3 | 2 |
| sympy-12489 | Permutation.get_precedence_matrix | 28 | 2484 | 2482 (0.09) | 1 | 6 | 1 |
| sympy-12489 | Permutation.josephus | 39 | 2668 | 2710 (0.58) | 3 | 10 | 3 |
| sympy-12489 | Permutation.mul_inv | 7 | 1233 | 1238 (0.60) | 2 | 4 | 2 |
| sympy-12489 | Permutation.next_trotterjohnson | 49 | 2430 | 2480 (0.80) | 3 | 5 | 3 |
| sympy-12489 | Permutation.random | 13 | 2741, 2744 | 2756 (0.77) | 2 | 3 | 2 |
| sympy-12489 | Permutation.rank | 32 | 1731 | 1729 (0.06) | 1 | 5 | 1 |
| sympy-12489 | Permutation.rank_nonlex | 29 | 1668 | 1666 (0.05) | 1 | 6 | 1 |
| sympy-12489 | Permutation.rmul_with_af | 8 | 1226, 1227 | 1229 (0.58) | 1 | 6 | 1 |
| sympy-12489 | Permutation.signature | 25 | 2132 | 2130 (0.10) | 1 | 4 | 1 |
| sympy-12489 | Permutation.transpositions | 31 | 1443 | 1441 (0.05) | 1 | 5 | 1 |
| sympy-12489 | Permutation.unrank_lex | 28 | 2760, 2763 | 2790 (0.67) | 2 | 3 | 2 |
| sympy-12489 | Permutation.unrank_nonlex | 25 | 1636 | 1664 (0.80) | 2 | 4 | 2 |
| sympy-12489 | Permutation.unrank_trotterjohnson | 30 | 2397 | 2426 (0.75) | 4 | 6 | 5 |
| django-14787 | _multi_decorate | 27 | 40 | 49 (0.30) | 2 | 2 | 1 |
| django-15315 | Field.__hash__ | 6 | 545, 546, 547, 548 ... | 545 (0.40) | 1 | 1 | 1 |
| django-15572 | get_template_directories | 19 | 20, 28 | 20 (0.61) | 1 | 1 | 1 |
| django-16100 | ModelAdmin.changelist_view | 161 | 2014, 2015, 2016, 2017 ... | 2002 (0.26) | 3 | 7 | 3 |
| django-14725 | BaseModelFormSet.save | 12 | 679 | 679 (0.80) | 1 | 1 | 1 |
| django-14725 | inlineformset_factory | 43 | 1079, 1111 | 1074 (0.55) | 3 | 3 | 2 |
| django-14725 | modelformset_factory | 27 | 878, 898 | 873 (0.48) | 2 | 2 | 1 |
| django-15103 | json_script | 6 | 86, 89 | 86 (0.93) | 1 | 1 | 1 |
| django-15103 | json_script | 12 | 64, 72, 73, 74 ... | 64 (0.85) | 1 | 1 | 1 |
| django-15375 | Aggregate.resolve_expression | 19 | 68 | 54 (0.27) | 3 | 3 | 3 |
| django-15563 | SQLUpdateCompiler.pre_sql_setup | 40 | 1839, 1853, 1855, 1857 | 1839 (0.68) | 1 | 1 | 1 |
| django-15563 | UpdateQuery.get_related_updates | 16 | 137 | 137 (0.60) | 1 | 1 | 1 |
| django-15916 | ModelFormMetaclass.__new__ | 67 | 260, 261, 262, 263 ... | 266 (0.35) | 1 | 1 | 1 |
| django-15916 | ModelFormOptions.__init__ | 10 | 255 | 255 (0.70) | 1 | 1 | 1 |
| django-15916 | modelform_factory | 72 | 639 | 633 (0.38) | 2 | 2 | 2 |
| django-15128 | Query.bump_prefix | 45 | 882, 885, 887, 907 ... | 917 (0.28) | 2 | 3 | 2 |
| django-15128 | Query.change_aliases | 35 | 848 | 849 (0.45) | 1 | 5 | 1 |
| django-15128 | Query.combine | 96 | 574, 592, 593, 594 | 607 (0.55) | 3 | 40 | 2 |
| pytest-10081 | TestCaseFunction.runtest | 25 | 319 | 319 (0.84) | 1 | 1 | 1 |
| pytest-7205 | _show_fixture_action | 24 | 69 | 69 (0.95) | 1 | 1 | 1 |
| pytest-10051 | LogCaptureFixture.clear | 3 | 443 | 443 (0.81) | 1 | 1 | 1 |
| pytest-7324 | MatcherAdapter.__getitem__ | 2 | 175 | 175 (0.60) | 1 | 1 | 1 |
| pytest-7324 | not_expr | 11 | 164 | 164 (0.49) | 1 | 1 | 1 |
| pytest-10356 | get_unpacked_marks | 6 | 358, 359, 360, 361 ... | 360 (0.85) | 1 | 1 | 1 |
| pytest-10356 | store_mark | 8 | 391 | 391 (0.81) | 1 | 1 | 1 |
| pylint-4970 | Similar.run | 3 | 392 | 393 (0.49) | 1 | 3 | 1 |
| pylint-4604 | VariablesChecker._store_type_annotation_node | 18 | 1828 | 1829 (0.27) | 1 | >all | 1 |
| pylint-6386 | _ArgumentsManager._add_parser_option | 76 | 220 | 208 (0.22) | 59 | 62 | 11 |
| pylint-6386 | _CallableArgument.__init__ | 17 | 459, 469 | 462 (0.28) | 1 | 15 | 1 |
| pylint-6386 | _convert_option_to_argument | 112 | 73 | 57 (0.33) | 11 | 48 | 9 |
| pylint-6386 | _make_run_options | 175 | 546, 556 | 543 (0.30) | 1 | 158 | 1 |
| pylint-6386 | _preprocess_options | 29 | 221 | 238 (0.40) | 2 | 2 | 2 |
| requests-1142 | PreparedRequest.prepare_content_length | 8 | 389, 395 | 389 (0.71) | 1 | 1 | 1 |
| requests-2931 | PreparedRequest.prepare_url | 62 | 387 | 351 (0.42) | 6 | >all | 6 |
| requests-2931 | RequestEncodingMixin._encode_params | 23 | 84 | 84 (0.58) | 1 | 1 | 1 |

### Q4 per instance, primary touched function (most changed lines)

| Instance | Primary function | lines | truth lines | names: top-1 (p) | rank +-3 | rank exact | +testcode: rank +-3 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sympy-12096 | Function._eval_evalf | 45 | 510 | 510 (0.93) | 1 | 1 | 1 |
| sympy-15345 | (module-level change only) | | | | | | |
| sympy-17139 | _TR56 | 49 | 502 | 504 (0.96) | 1 | 30 | 1 |
| sympy-19954 | PermutationGroup.minimal_blocks | 76 | 2197, 2201, 2202, 2208 | 2201 (0.60) | 1 | 1 | 1 |
| sympy-11618 | Point.distance | 24 | 268 | 269 (0.83) | 1 | 24 | 1 |
| sympy-13798 | LatexPrinter.__init__ | 22 | 158, 159, 160, 161 ... | 160 (0.65) | 1 | 1 | 1 |
| sympy-16792 | CodeGen.routine | 143 | 697, 706, 708, 709 ... | 643 (0.41) | 2 | 11 | 2 |
| sympy-20428 | ExpressionDomain.Expression.__bool__ | 2 | 123 | 123 (0.66) | 1 | 1 | 1 |
| sympy-22080 | CodePrinter._print_Mul | 40 | 490 | 486 (0.24) | 19 | 33 | 20 |
| sympy-12489 | Permutation.__new__ | 107 | 860, 862, 865, 868 ... | 860 (0.41) | 1 | 1 | 1 |
| django-14787 | _multi_decorate | 27 | 40 | 49 (0.30) | 2 | 2 | 1 |
| django-15315 | Field.__hash__ | 6 | 545, 546, 547, 548 ... | 545 (0.40) | 1 | 1 | 1 |
| django-15572 | get_template_directories | 19 | 20, 28 | 20 (0.61) | 1 | 1 | 1 |
| django-16100 | ModelAdmin.changelist_view | 161 | 2014, 2015, 2016, 2017 ... | 2002 (0.26) | 3 | 7 | 3 |
| django-14725 | modelformset_factory | 27 | 878, 898 | 873 (0.48) | 2 | 2 | 1 |
| django-15103 | json_script | 12 | 64, 72, 73, 74 ... | 64 (0.85) | 1 | 1 | 1 |
| django-15375 | Aggregate.resolve_expression | 19 | 68 | 54 (0.27) | 3 | 3 | 3 |
| django-15563 | SQLUpdateCompiler.pre_sql_setup | 40 | 1839, 1853, 1855, 1857 | 1839 (0.68) | 1 | 1 | 1 |
| django-15916 | ModelFormMetaclass.__new__ | 67 | 260, 261, 262, 263 ... | 266 (0.35) | 1 | 1 | 1 |
| django-15128 | Query.bump_prefix | 45 | 882, 885, 887, 907 ... | 917 (0.28) | 2 | 3 | 2 |
| pytest-10081 | TestCaseFunction.runtest | 25 | 319 | 319 (0.84) | 1 | 1 | 1 |
| pytest-7205 | _show_fixture_action | 24 | 69 | 69 (0.95) | 1 | 1 | 1 |
| pytest-10051 | LogCaptureFixture.clear | 3 | 443 | 443 (0.81) | 1 | 1 | 1 |
| pytest-7324 | MatcherAdapter.__getitem__ | 2 | 175 | 175 (0.60) | 1 | 1 | 1 |
| pytest-10356 | get_unpacked_marks | 6 | 358, 359, 360, 361 ... | 360 (0.85) | 1 | 1 | 1 |
| pylint-4970 | Similar.run | 3 | 392 | 393 (0.49) | 1 | 3 | 1 |
| pylint-4604 | VariablesChecker._store_type_annotation_node | 18 | 1828 | 1829 (0.27) | 1 | >all | 1 |
| pylint-6386 | _CallableArgument.__init__ | 17 | 459, 469 | 462 (0.28) | 1 | 15 | 1 |
| requests-1142 | PreparedRequest.prepare_content_length | 8 | 389, 395 | 389 (0.71) | 1 | 1 | 1 |
| requests-2931 | RequestEncodingMixin._encode_params | 23 | 84 | 84 (0.58) | 1 | 1 | 1 |

## Q5 directory-level Choice over the whole repository

| n | dirs p50 (min-max) | top-1 | top-5 | MRR | escape mass max | input tokens p50 / max | cost (USD) | latency p50 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 30 | 75 (7-100) | 23/30 (77%) | 29/30 (97%) | 0.87 | 0.15 | 7,774 / 9,397 | 0.0073 | 225 |

| Instance | dirs | gold dir: p | Jev top-1 (p) | rank |
| --- | --- | --- | --- | --- |
| sympy-12096 | 60 | sympy_core 1.00 | sympy_core (1.00) | 1 |
| sympy-15345 | 75 | sympy_printing 0.72 | sympy_printing (0.72) | 1 |
| sympy-17139 | 75 | sympy_simplify 1.00 | sympy_simplify (1.00) | 1 |
| sympy-19954 | 81 | sympy_combinatorics 1.00 | sympy_combinatorics (1.00) | 1 |
| sympy-11618 | 60 | sympy_geometry 0.99 | sympy_geometry (0.99) | 1 |
| sympy-13798 | 64 | sympy_printing 0.99 | sympy_printing (0.99) | 1 |
| sympy-16792 | 75 | sympy_utilities 0.21 | sympy_codegen (0.75) | 2 |
| sympy-20428 | 81 | sympy_polys_domains 0.01 | sympy_polys (0.99) | 2 |
| sympy-22080 | 85 | sympy_printing 0.01 | sympy_utilities (0.81) | 6 |
| sympy-12489 | 60 | sympy_combinatorics 0.99 | sympy_combinatorics (0.99) | 1 |
| django-14787 | 100 | django_utils 0.36 | django_utils (0.36) | 1 |
| django-15315 | 100 | django_db_models_fields 0.75 | django_db_models_fields (0.75) | 1 |
| django-15572 | 100 | django_template 0.97 | django_template (0.97) | 1 |
| django-16100 | 100 | django_contrib_admin 0.21 | django_contrib_admin_views (0.77) | 2 |
| django-14725 | 100 | django_forms 1.00 | django_forms (1.00) | 1 |
| django-15103 | 100 | django_template 0.22, django_utils 0.03 | django_templatetags (0.31) | 2 |
| django-15375 | 100 | django_db_models 0.68 | django_db_models (0.68) | 1 |
| django-15563 | 100 | django_db_models_sql 0.24 | django_db_models (0.75) | 2 |
| django-15916 | 100 | django_forms 0.99 | django_forms (0.99) | 1 |
| django-15128 | 100 | django_db_models_sql 0.91 | django_db_models_sql (0.91) | 1 |
| pytest-10081 | 7 | src_pytest 0.98 | src_pytest (0.98) | 1 |
| pytest-7205 | 7 | src_pytest 0.99 | src_pytest (0.99) | 1 |
| pytest-10051 | 7 | src_pytest 1.00 | src_pytest (1.00) | 1 |
| pytest-7324 | 7 | src_pytest_mark 0.80 | src_pytest_mark (0.80) | 1 |
| pytest-10356 | 7 | src_pytest_mark 0.81 | src_pytest_mark (0.81) | 1 |
| pylint-4970 | 13 | pylint_checkers 0.08 | pylint_checkers_refactoring (0.81) | 2 |
| pylint-4604 | 13 | pylint_checkers 0.99, pylint 0.01 | pylint_checkers (0.99) | 1 |
| pylint-6386 | 17 | pylint_config 0.80, pylint_lint 0.12 | pylint_config (0.80) | 1 |
| requests-1142 | 7 | requests 0.62 | requests (0.62) | 1 |
| requests-2931 | 8 | requests 0.96 | requests (0.96) | 1 |

## Q6 repo-wide file Nouls (every source .py file, paths only)

| n | files p50 (min-max) | requests per instance | gold ranked 1 | <= 5 | <= 10 | MRR | micro P/R at 0.5 | at 0.7 | at 0.9 | files selected at 0.5 p50 / max | tokens per instance p50 | cost (USD) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 30 | 644 (61-778) | 1-4 | 23/30 (77%) | 28/30 (93%) | 30/30 (100%) | 0.85 | P 26/48 = 0.54, R 26/37 = 0.70 | P 23/29 = 0.79, R 23/37 = 0.62 | P 12/13 = 0.92, R 12/37 = 0.32 | 1 / 3 | 34,776 | 0.0328 |

| Instance | files | gold file: p (rank among all files) | selected at 0.5 (tp) | at 0.7 (tp) | strongest non-gold file (p) |
| --- | --- | --- | --- | --- | --- |
| sympy-12096 | 545 | function.py 0.92 (#1) | 1 (1) | 1 (1) | sympy/core/evalf.py 0.26 |
| sympy-15345 | 663 | mathematica.py 0.90 (#1) | 1 (1) | 1 (1) | sympy/core/backend.py 0.47 |
| sympy-17139 | 672 | fu.py 0.94 (#1) | 1 (1) | 1 (1) | sympy/core/function.py 0.20 |
| sympy-19954 | 726 | perm_groups.py 0.96 (#1) | 1 (1) | 1 (1) | sympy/combinatorics/util.py 0.09 |
| sympy-11618 | 544 | point.py 0.89 (#1) | 3 (1) | 1 (1) | sympy/vector/point.py 0.64 |
| sympy-13798 | 592 | latex.py 0.93 (#1) | 1 (1) | 1 (1) | sympy/printing/printer.py 0.25 |
| sympy-16792 | 668 | codegen.py 0.79 (#1) | 3 (1) | 1 (1) | sympy/printing/ccode.py 0.60 |
| sympy-20428 | 732 | expressiondomain.py 0.27 (#9) | 2 (0) | 0 (0) | sympy/polys/polyclasses.py 0.62 |
| sympy-22080 | 778 | codeprinter.py 0.31 (#10), precedence.py 0.10 (#44) | 1 (0) | 1 (0) | sympy/utilities/lambdify.py 0.85 |
| sympy-12489 | 550 | permutations.py 0.95 (#1) | 1 (1) | 1 (1) | sympy/core/basic.py 0.13 |
| django-14787 | 644 | decorators.py 0.82 (#1) | 1 (1) | 1 (1) | django/views/decorators/__init__.py 0.43 |
| django-15315 | 645 | __init__.py 0.92 (#1) | 1 (1) | 1 (1) | django/db/models/fields/mixins.py 0.15 |
| django-15572 | 646 | autoreload.py 0.90 (#1) | 1 (1) | 1 (1) | django/utils/autoreload.py 0.23 |
| django-16100 | 646 | options.py 0.44 (#2) | 1 (0) | 1 (0) | django/contrib/admin/views/main.py 0.87 |
| django-14725 | 645 | models.py 0.61 (#2) | 2 (1) | 1 (0) | django/forms/formsets.py 0.82 |
| django-15103 | 644 | defaultfilters.py 0.44 (#3), html.py 0.39 (#5) | 2 (0) | 0 (0) | django/template/defaulttags.py 0.66 |
| django-15375 | 645 | aggregates.py 0.83 (#1) | 2 (1) | 1 (1) | django/db/models/functions/math.py 0.61 |
| django-15563 | 646 | compiler.py 0.55 (#3), subqueries.py 0.22 (#6) | 3 (1) | 2 (0) | django/db/models/query.py 0.85 |
| django-15916 | 646 | models.py 0.94 (#1) | 1 (1) | 1 (1) | django/forms/forms.py 0.16 |
| django-15128 | 644 | query.py 0.95 (#2) | 2 (1) | 2 (1) | django/db/models/query.py 0.95 |
| pytest-10081 | 66 | unittest.py 0.78 (#1) | 1 (1) | 1 (1) | src/_pytest/skipping.py 0.42 |
| pytest-7205 | 61 | setuponly.py 0.94 (#1) | 1 (1) | 1 (1) | src/_pytest/_io/saferepr.py 0.21 |
| pytest-10051 | 66 | logging.py 0.97 (#1) | 1 (1) | 1 (1) | src/_pytest/fixtures.py 0.03 |
| pytest-7324 | 62 | expression.py 0.76 (#1) | 3 (1) | 1 (1) | src/_pytest/mark/evaluate.py 0.59 |
| pytest-10356 | 66 | structures.py 0.76 (#1) | 3 (1) | 1 (1) | src/_pytest/python.py 0.55 |
| pylint-4970 | 118 | similar.py 0.88 (#1) | 1 (1) | 1 (1) | pylint/checkers/refactoring/refactoring_checker.py 0.37 |
| pylint-4604 | 112 | variables.py 0.72 (#1), constants.py 0.08 (#15) | 2 (1) | 1 (1) | pylint/checkers/imports.py 0.64 |
| pylint-6386 | 163 | argument.py 0.31 (#5), arguments_manager.py 0.31 (#6), utils.py 0.12 (#17), base_options.py 0.70 (#1) | 2 (1) | 1 (1) | pylint/config/option.py 0.55 |
| requests-1142 | 66 | models.py 0.71 (#1) | 1 (1) | 1 (1) | requests/packages/urllib3/request.py 0.41 |
| requests-2931 | 80 | models.py 0.57 (#1) | 2 (1) | 0 (0) | requests/compat.py 0.54 |

## Chained view per instance (each stage given the previous stage's gold input)

Q6 file = gold file (primary) ranked first among all repo files; Q2 fn = a touched function in top-5 of the gold file (`ps`); Q4 line = a target line within +-3 in top-5 of the primary function (`names`). "all top-1" tightens every stage to top-1.

| Instance | Q5 dir top-1 | Q6 file rank | Q2 fn rank | Q4 line rank (+-3) | file#1 & fn<=5 & line<=5 | all top-1 |
| --- | --- | --- | --- | --- | --- | --- |
| sympy-12096 | yes | 1 | 1 | 1 | yes | yes |
| sympy-15345 | yes | 1 | 1 | n/a (module-level) | yes | yes |
| sympy-17139 | yes | 1 | 1 | 1 | yes | yes |
| sympy-19954 | yes | 1 | 1 | 1 | yes | yes |
| sympy-11618 | yes | 1 | 1 | 1 | yes | yes |
| sympy-13798 | yes | 1 | 2 | 1 | yes | no |
| sympy-16792 | no (#2) | 1 | 2 | 2 | yes | no |
| sympy-20428 | no (#2) | 9 | 2 | 1 | no | no |
| sympy-22080 | no (#6) | 10 | 1 | 19 | no | no |
| sympy-12489 | yes | 1 | 1 | 1 | yes | yes |
| django-14787 | yes | 1 | 3 | 2 | yes | no |
| django-15315 | yes | 1 | 1 | 1 | yes | yes |
| django-15572 | yes | 1 | 2 | 1 | yes | no |
| django-16100 | no (#2) | 2 | 1 | 3 | no | no |
| django-14725 | yes | 2 | 2 | 2 | no | no |
| django-15103 | no (#2) | 5 | 1 | 1 | no | no |
| django-15375 | yes | 1 | 2 | 3 | yes | no |
| django-15563 | no (#2) | 3 | 2 | 1 | no | no |
| django-15916 | yes | 1 | 1 | 1 | yes | yes |
| django-15128 | yes | 2 | 1 | 2 | no | no |
| pytest-10081 | yes | 1 | 7 | 1 | no | no |
| pytest-7205 | yes | 1 | 1 | 1 | yes | yes |
| pytest-10051 | yes | 1 | 1 | 1 | yes | yes |
| pytest-7324 | yes | 1 | 3 | 1 | yes | no |
| pytest-10356 | yes | 1 | 1 | 1 | yes | yes |
| pylint-4970 | no (#2) | 1 | 3 | 1 | yes | no |
| pylint-4604 | yes | 1 | 3 | 1 | yes | no |
| pylint-6386 | yes | 17 | 2 | 11 | no | no |
| requests-1142 | yes | 1 | 1 | 1 | yes | yes |
| requests-2931 | yes | 1 | 2 | 1 | yes | no |

Chained: 21/30 instances pass file top-1, function top-5 and line top-5; 12/30 pass every stage at top-1.
