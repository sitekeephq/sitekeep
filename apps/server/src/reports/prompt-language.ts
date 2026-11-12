/**
 * Language of everything the report builder sends to the model (system prompt, dataset catalog,
 * example dashboard, validation errors on repair): the prompts are written in Turkish and ask for
 * Turkish dashboards, so their inputs stay Turkish whatever the reader's language
 * (docs/architecture/i18n.md §8.2).
 */
export const PROMPT_LANGUAGE = "tr";
