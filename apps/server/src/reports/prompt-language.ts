/**
 * Language of the report builder's model-facing inputs that do not depend on the reader (dataset
 * catalog and validation errors of "Yapay zekâ ile onar"): the prompts are written for Turkish
 * inputs (docs/architecture/i18n.md §8.2). What the model writes for the user follows the reader's
 * language (§8.4); a new dashboard's catalog and example are described in that language too.
 */
export const PROMPT_LANGUAGE = "tr";
