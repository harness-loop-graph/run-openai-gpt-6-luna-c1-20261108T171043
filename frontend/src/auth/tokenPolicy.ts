import { api, Tokens } from "../api/client";

let refreshTimer: number | undefined;
export function retainTokens(tokens: Tokens): void {
  sessionStorage.setItem("access_token", tokens.access_token);
  sessionStorage.setItem("refresh_token", tokens.refresh_token);
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(
    () => {
      const refreshToken = sessionStorage.getItem("refresh_token");
      if (refreshToken)
        void api<Tokens>("/auth/token/refresh", {
          method: "POST",
          body: JSON.stringify({ refresh_token: refreshToken }),
        })
          .then(retainTokens)
          .catch(() => sessionStorage.clear());
    },
    14 * 60 * 1000,
  );
}
