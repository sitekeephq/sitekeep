/** Signed-out storage state with the Turkish interface, for specs that test the login page. */
import { signedOutState } from "./global-setup";

export const E2E_BASE_URL = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 18080)}`;
export { signedOutState };
