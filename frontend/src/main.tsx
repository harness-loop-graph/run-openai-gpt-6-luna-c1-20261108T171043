import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, Tokens } from "./api/client";
import { challenge, randomVerifier } from "./auth/pkce";
import "./style.css";

type User = { id: number; role: string; patientId?: number };
type Appointment = {
  id: number;
  start: string;
  end: string;
  estado: string;
  professional?: string;
};
type Slot = { start: string; end: string };

function App(): React.JSX.Element {
  const [user, setUser] = useState<User | null>(() => {
    const raw = sessionStorage.getItem("user");
    const token = sessionStorage.getItem("access_token");
    return raw && token ? (JSON.parse(raw) as User) : null;
  });
  const [page, setPage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [professionals, setProfessionals] = useState<
    Array<{ id: number; name: string }>
  >([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selected, setSelected] = useState("");
  const [professional, setProfessional] = useState("1");
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState(
    new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
  );
  const [history, setHistory] = useState<
    Array<{ notes: string; diagnosis: string; id: number }>
  >([]);
  const [agenda, setAgenda] = useState<Appointment[]>([]);
  const [selectedAppt, setSelectedAppt] = useState<number | null>(null);
  const [users, setUsers] = useState<
    Array<{ id: number; email: string; roles: string[] }>
  >([]);
  const [audit, setAudit] = useState<
    Array<{ action: string; resourceType: string; resourceId: string }>
  >([]);

  async function load(route: string): Promise<void> {
    if (!user) return;
    setBusy(true);
    setError("");
    setPage(route);
    try {
      if (route === "bookings") setAppointments(await api("/me/appointments"));
      if (route === "search") setProfessionals(await api("/professionals"));
      if (route === "agenda") {
        const start = new Date();
        const end = new Date(Date.now() + 7 * 86400000);
        setAgenda(
          await api(
            `/agenda?from=${start.toISOString().slice(0, 10)}&to=${end.toISOString().slice(0, 10)}`,
          ),
        );
      }
      if (route === "history") {
        const patientId = user.patientId ?? Number(prompt("Patient ID") ?? "0");
        setHistory(await api(`/patients/${patientId}/clinical-history`));
      }
      if (route === "admin")
        setUsers(
          (await api<{ items: typeof users }>("/admin/users?page=1")).items,
        );
      if (route === "audit")
        setAudit((await api<{ items: typeof audit }>("/admin/audit")).items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) return;
    const state = params.get("state");
    const expected = sessionStorage.getItem("oauth_state");
    const verifier = sessionStorage.getItem("pkce_verifier");
    if (state !== expected || !verifier) {
      setError("Invalid authorization response");
      return;
    }
    void api<Tokens>("/auth/token", {
      method: "POST",
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        client_id: "medapp-spa",
        redirect_uri: "http://localhost:8080/auth/callback",
      }),
    })
      .then(async (tokens) => {
        sessionStorage.setItem("access_token", tokens.access_token);
        sessionStorage.setItem("refresh_token", tokens.refresh_token);
        const me = await api<User>("/me");
        if (me.role === "professional")
          me.patientId = (
            await api<{ id: number }>(`/professional-id/${me.id}`)
          ).id;
        setUser(me);
        sessionStorage.setItem("user", JSON.stringify(me));
        window.history.replaceState({}, "", "/");
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Login failed"),
      );
  }, []);

  async function login(): Promise<void> {
    const verifier = randomVerifier();
    const state = randomVerifier();
    sessionStorage.setItem("pkce_verifier", verifier);
    sessionStorage.setItem("oauth_state", state);
    const digest = await challenge(verifier);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: "medapp-spa",
      redirect_uri: "http://localhost:8080/auth/callback",
      code_challenge: digest,
      code_challenge_method: "S256",
      state,
    });
    window.location.href = `http://localhost:3000/auth/authorize?${query.toString()}`;
  }

  async function search(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      setSlots(
        await api(
          `/availability?professionalId=${professional}&from=${from}&to=${to}`,
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Search failed");
    } finally {
      setBusy(false);
    }
  }

  async function book(): Promise<void> {
    if (!selected) return;
    try {
      await api("/appointments", {
        method: "POST",
        body: JSON.stringify({
          professionalId: Number(professional),
          slotStart: selected,
        }),
      });
      setSlots(slots.filter((slot) => slot.start !== selected));
      setSelected("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Booking failed");
    }
  }

  async function logout(): Promise<void> {
    try {
      await api("/auth/revoke", {
        method: "POST",
        body: JSON.stringify({ token: sessionStorage.getItem("access_token") }),
      });
    } catch {
      /* local logout remains effective */
    }
    sessionStorage.clear();
    setUser(null);
    setPage("");
  }

  async function encounter(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api(`/appointments/${selectedAppt}/encounter`, {
        method: "POST",
        body: JSON.stringify({
          notes: data.get("notes"),
          diagnosis: data.get("diagnosis"),
        }),
      });
      setError("Encounter recorded");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Encounter failed");
    }
  }

  if (!user)
    return (
      <main className="login">
        <h1>Medical Appointments</h1>
        {error && <div data-testid="error-banner">{error}</div>}
        <label>
          Email
          <input
            data-testid="login-email"
            type="email"
            autoComplete="username"
          />
        </label>
        <label>
          Password
          <input
            data-testid="login-password"
            type="password"
            autoComplete="current-password"
          />
        </label>
        <button data-testid="login-submit" onClick={() => void login()}>
          Sign in
        </button>
        <p>Use your account to continue.</p>
      </main>
    );

  const nav =
    user.role === "patient"
      ? [
          ["bookings", "My appointments", "nav-bookings"],
          ["search", "Find a slot", "nav-search"],
          ["history", "Clinical history", "nav-history"],
        ]
      : user.role === "professional"
        ? [
            ["agenda", "Agenda", "nav-agenda"],
            ["history", "Clinical history", "nav-history"],
          ]
        : user.role === "staff"
          ? [
              ["agenda", "Agenda", "nav-agenda"],
              ["search", "Availability", "nav-search"],
            ]
          : [
              ["admin", "Administration", "nav-admin"],
              ["audit", "Audit log", "nav-audit"],
            ];
  const openAppointment = (id: number): void => {
    setSelectedAppt(id);
    setPage("detail");
  };

  return (
    <div className="app">
      <header>
        <h1>Medical Appointments</h1>
        <span>{user.role}</span>
        <button onClick={() => void logout()}>Sign out</button>
      </header>
      <nav>
        {nav.map(([route, label, testid]) => (
          <button
            key={route}
            data-testid={testid}
            onClick={() => void load(route)}
          >
            {label}
          </button>
        ))}
      </nav>
      <main>
        {busy && <p data-testid="loading-indicator">Loading…</p>}
        {error && <div data-testid="error-banner">{error}</div>}
        {page === "bookings" && (
          <section>
            <h2>My appointments</h2>
            {appointments.length ? (
              appointments.map((item) => (
                <article
                  key={item.id}
                  data-testid="appointment-item"
                  data-appointment-id={item.id}
                >
                  {new Date(item.start).toLocaleString()} — {item.professional}{" "}
                  ({item.estado})
                  {item.estado === "scheduled" && (
                    <button
                      data-testid="cancel-appointment"
                      onClick={async () => {
                        await api(`/appointments/${item.id}`, {
                          method: "DELETE",
                        });
                        setAppointments(
                          appointments.filter((a) => a.id !== item.id),
                        );
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </article>
              ))
            ) : (
              <p data-testid="empty-state">No appointments.</p>
            )}
          </section>
        )}
        {page === "search" && (
          <section>
            <h2>Availability search</h2>
            <label>
              Professional
              <select
                data-testid="search-professional"
                value={professional}
                onChange={(event) => setProfessional(event.target.value)}
              >
                {professionals.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              From
              <input
                data-testid="search-from"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label>
              To
              <input
                data-testid="search-to"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
            <button data-testid="search-submit" onClick={() => void search()}>
              Search
            </button>
            {slots.length ? (
              <div>
                {slots.map((slot) => (
                  <button
                    key={slot.start}
                    data-testid="slot-item"
                    data-slot-start={slot.start}
                    className={selected === slot.start ? "selected" : ""}
                    onClick={() => setSelected(slot.start)}
                  >
                    {new Date(slot.start).toLocaleString()}
                  </button>
                ))}
                <button data-testid="book-submit" onClick={() => void book()}>
                  Book selected slot
                </button>
              </div>
            ) : (
              <p data-testid="empty-state">No slots found.</p>
            )}
          </section>
        )}
        {page === "agenda" && (
          <section>
            <h2>Agenda</h2>
            {agenda.length ? (
              agenda.map((item) => (
                <article
                  key={item.id}
                  data-testid="appointment-item"
                  data-appointment-id={item.id}
                  onClick={() => openAppointment(item.id)}
                >
                  {new Date(item.start).toLocaleString()} · {item.estado}
                </article>
              ))
            ) : (
              <p data-testid="empty-state">No appointments this week.</p>
            )}
          </section>
        )}
        {page === "detail" && (
          <section>
            <h2>Appointment {selectedAppt}</h2>
            <form onSubmit={(event) => void encounter(event)}>
              <label>
                Notes
                <textarea name="notes" data-testid="encounter-notes" required />
              </label>
              <label>
                Diagnosis
                <input
                  name="diagnosis"
                  data-testid="encounter-diagnosis"
                  required
                />
              </label>
              <button data-testid="encounter-submit" type="submit">
                Record encounter
              </button>
            </form>
          </section>
        )}
        {page === "history" && (
          <section>
            <h2>Clinical history</h2>
            {history.length ? (
              <div data-testid="history-timeline">
                {history.map((item) => (
                  <article key={item.id}>
                    <p>{item.notes}</p>
                    <p>{item.diagnosis}</p>
                  </article>
                ))}
              </div>
            ) : (
              <p data-testid="empty-state">No history available.</p>
            )}
          </section>
        )}
        {page === "admin" && (
          <section>
            <h2>Users and roles</h2>
            {users.map((item) => (
              <article key={item.id}>
                {item.email}: {item.roles.join(", ")}
              </article>
            ))}
            <label>
              Professional ID
              <input id="professional-id" />
            </label>
            <label>
              Availability JSON
              <textarea id="availability-json" defaultValue="[]" />
            </label>
            <button
              onClick={() => {
                const id = Number(
                  (
                    document.getElementById(
                      "professional-id",
                    ) as HTMLInputElement
                  ).value,
                );
                const slots = JSON.parse(
                  (
                    document.getElementById(
                      "availability-json",
                    ) as HTMLTextAreaElement
                  ).value,
                ) as Slot[];
                void api(`/admin/professionals/${id}/availability`, {
                  method: "PUT",
                  body: JSON.stringify({ slots }),
                }).catch((reason: Error) => setError(reason.message));
              }}
            >
              Replace availability
            </button>
          </section>
        )}
        {page === "audit" && (
          <section>
            <h2>Audit log</h2>
            {audit.length ? (
              audit.map((item, i) => (
                <article key={`${item.resourceId}-${i}`}>
                  {item.action} {item.resourceType} {item.resourceId}
                </article>
              ))
            ) : (
              <p data-testid="empty-state">No audit entries.</p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
