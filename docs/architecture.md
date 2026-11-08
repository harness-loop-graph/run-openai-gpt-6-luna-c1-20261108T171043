# Architecture

## Entity model

`usuario` has one or more `rol` rows through `usuario_rol`; patient and professional profiles reference their user. `disponibilidad` belongs to a professional. `cita` links patient, professional, and a start/end slot; a partial unique index prevents duplicate non-cancelled bookings. `encuentro` belongs to a cita and versions append-only clinical notes and diagnosis. `adjunto` belongs to an encounter. `auditoria` stores append-only actor/action/resource events.

## Endpoint-to-screen map

| Endpoint | Screen / use |
|---|---|
| EP-01..04 | SCR-01 OAuth login, token lifecycle |
| EP-05, EP-08 | SCR-02 patient appointments and cancellation |
| EP-06, EP-07 | SCR-03 availability and booking |
| EP-09, EP-10 | SCR-04 agenda and SCR-05 appointment details |
| EP-11 | SCR-05 encounter recording |
| EP-12, EP-13, EP-14 | SCR-06 clinical history and attachments |
| EP-15..18 | SCR-07 administration |
| EP-19 | SCR-08 audit query |
| EP-20 | service health |
