/** The one i18next instance of the app; index.ts configures it. Separate file so helpers can import it without a cycle. */
import i18next, { type i18n as I18n } from "i18next";

export const i18n: I18n = i18next.createInstance();
