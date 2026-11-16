import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { UserDto } from "@sitekeep/shared";
import { api } from "../../shared/api/api";
import { queryClient } from "../providers/QueryProvider";
import { TOUR_STORAGE_KEY } from "../../features/onboarding/tour";
import { currentLanguage, setLanguage, supportedLanguage } from "../../i18n";
import { hubApi } from "../../shared/api/api-hub";
import { isChallenge } from "../../shared/api/api-security";

/**
 * The profile's language wins once the user is known (another device chose it); a profile without
 * one takes the language picked on this browser, e.g. on the sign-in page.
 */
function syncLanguage(user: UserDto | null) {
  if (!user) return;
  const chosen = supportedLanguage(user.language);
  if (chosen && chosen !== currentLanguage()) void setLanguage(chosen);
  else if (!user.language) void hubApi.setPrefs({ language: currentLanguage() }).catch(() => undefined);
}

interface AuthState {
  user: UserDto | null;
  loading: boolean;
  /** Password just used at login, for the forced-change form. */
  pendingCurrentPassword: string;
  /** "verify" / "enrol": a two-factor step follows (Login page), then completeSignIn. */
  login(email: string, password: string, privacyNoticeVersion?: number): Promise<"done" | "verify" | "enrol">;
  /** The user after the second step; the password is the one typed at the first (forced-change form). */
  completeSignIn(user: UserDto, password?: string): void;
  logout(): Promise<void>;
  reloadUser(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingCurrentPassword, setPendingCurrentPassword] = useState("");

  useEffect(() => {
    api
      .me()
      .then((u) => {
        setUser(u);
        syncLanguage(u);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    const onUnauthorized = () => {
      queryClient.clear();
      setUser(null);
    };
    window.addEventListener("cde:unauthorized", onUnauthorized);
    return () => window.removeEventListener("cde:unauthorized", onUnauthorized);
  }, []);

  const completeSignIn = useCallback((next: UserDto, password = "") => {
    setUser(next);
    syncLanguage(next);
    setPendingCurrentPassword(next.mustChangePassword ? password : "");
    if (next.mustChangePassword) {
      try {
        localStorage.removeItem(TOUR_STORAGE_KEY);
      } catch {
        /* private mode */
      }
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string, privacyNoticeVersion?: number) => {
      const next = await api.login(email, password, privacyNoticeVersion);
      if (isChallenge(next)) return next.twoFactor;
      completeSignIn(next, password);
      return "done" as const;
    },
    [completeSignIn],
  );

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    queryClient.clear();
    setUser(null);
    setPendingCurrentPassword("");
  }, []);

  const reloadUser = useCallback(async () => {
    const next = await api.me();
    setUser(next);
    if (!next?.mustChangePassword) setPendingCurrentPassword("");
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, pendingCurrentPassword, login, completeSignIn, logout, reloadUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
