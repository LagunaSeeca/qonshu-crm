# Qonshu CRM ↔ Partner App API Contract

**For:** the Django backend developer of the partner mobile app
**From:** the Qonshu CRM team
**Version:** 1.0 (2026-07-17)
**Status:** proposal — please review the **Open questions** at the end and reply with your decisions.

---

## 1. What this is

Qonshu CRM is our internal platform for managing sales leads and partner accounts. For every **partner** (a company that uses your mobile app), the CRM shows an **Analytics** view:

- how many app users they have (total / active), and **how many actually installed + logged in** (activation)
- **iOS vs Android** install counts
- **payments** made by their users through the app: totals, breakdown by **payment method** and by **category**, a daily trend, top users, and a searchable transaction list
- total outstanding **debt** across their users

The CRM does **not** write anything back to your system. This is **read-only, one-way**: your API → our CRM.

Today the CRM runs against a mock data source. We built it behind a single interface, so **when your endpoints exist we swap the mock out with zero changes to our UI or calculations** — provided the payloads match the shapes below.

We need **two endpoints**: one for users, one for payments.

---

## 2. Conventions

| Topic | Rule |
|---|---|
| Format | JSON, `Content-Type: application/json; charset=utf-8` |
| Dates/times | **ISO 8601 with timezone**, UTC preferred — e.g. `2026-07-15T10:32:00Z`. Never local time without an offset. |
| Money | Decimal **number** with 2 decimals — e.g. `149.90`. Not a string, not cents-as-integer. (If you must send strings, say so and we'll parse.) |
| Currency | Assumed a single currency per partner. If that's wrong, tell us — we'll add a `currency` field. |
| IDs | Strings. Must be **stable forever** for the same entity (see §5 idempotency). |
| Unknown enum value | Send the string anyway; we'll map unknown values to a safe default rather than fail. Don't invent new enum names silently — ping us. |
| Empty result | `200` with an empty `results` array. **Not** `404`. |

---

## 3. Authentication

Proposed: a static API token issued to us, sent on every request:

```
Authorization: Bearer <QONSHU_API_TOKEN>
```

We'll store it as a server-side secret; it never reaches a browser. Rotate by issuing a new one — tell us and we'll switch.

**Tell us:** your preferred scheme (Bearer token / API key header / HMAC signature), and the **base URL** for staging and production.

---

## 4. Identifying a partner

Every request is scoped to **one partner**. We need a stable partner identifier that both sides agree on.

Proposal: you expose your partner's primary key or slug (e.g. `acme-towers` or `142`), we store it on our Account record as `externalPartnerId`, and we pass it in the path:

```
GET /api/qonshu/partners/{partner_id}/users
GET /api/qonshu/partners/{partner_id}/payments
```

(The exact path is yours to choose — just keep the partner scoping explicit.)

**Tell us:** what identifier to use, and how we obtain the list of partner ids initially (a third endpoint `GET /api/qonshu/partners` returning `[{id, name}]` would be ideal, so we can map them to our accounts without manual data entry).

---

## 5. Endpoint 1 — Users

```
GET /api/qonshu/partners/{partner_id}/users?page=1&page_size=200
```

Returns every app user belonging to that partner.

### Response

```json
{
  "count": 1342,
  "next": "https://api.example.com/api/qonshu/partners/142/users?page=2&page_size=200",
  "results": [
    {
      "external_id": "usr_10293",
      "name": "Aysel Mammadova",
      "active": true,
      "debt": 120.50,
      "joined_at": "2025-11-03T08:14:00Z",
      "platform": "IOS",
      "installed_at": "2025-11-03T08:10:00Z",
      "last_login_at": "2026-07-14T19:02:11Z",
      "app_token": "d41d8cd98f00b204e9800998ecf8427e"
    }
  ]
}
```

### Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `external_id` | string | **yes** | Your stable unique id for this user. **Never reuse or change it** — we key on it. |
| `name` | string | **yes** | Display name. If you can't share real names for privacy, send a masked label (e.g. `Apt 12B`) — tell us which. |
| `active` | boolean | **yes** | Is the account currently active/enabled in your system (not deleted/suspended)? |
| `debt` | number | **yes** | Current **outstanding balance** this user owes (0 if none). Not lifetime billed. |
| `joined_at` | datetime | **yes** | When the user was registered in your system. |
| `platform` | enum | **yes** | `IOS` \| `ANDROID` \| `UNKNOWN` — the device platform of the install. Use `UNKNOWN` if you genuinely don't know. |
| `installed_at` | datetime \| null | **yes** | When the app was installed. `null` if never installed (registered but no app). Drives our **install counts**. |
| `last_login_at` | datetime \| null | **yes** | Last successful **login** in the app. `null` = never logged in. **This drives our "activated" metric.** |
| `app_token` | string \| null | no | The app token issued to this user, if you have one. Presence is a secondary signal that they logged in. See the privacy note below. |

### Why `last_login_at` matters

We report an **activation rate**: installs alone don't prove usage. A user counts as **activated** when `last_login_at` is set — i.e. they downloaded the app **and** signed in. If `last_login_at` is hard for you to expose, tell us — we can fall back to `app_token` presence, but a real timestamp is much better (it also lets us show recency later).

### Privacy note on `app_token`

We only need to know **that** a token exists, not its value. If the token is a credential (can be used to act as the user), **do not send it** — send `app_token: null` and rely on `last_login_at`, or send a boolean `has_app_token` instead. Tell us which you prefer; we'll adapt.

---

## 6. Endpoint 2 — Payments

```
GET /api/qonshu/partners/{partner_id}/payments?since=2026-04-16T00:00:00Z&page=1&page_size=500
```

Returns individual payment transactions made by that partner's users **through your app**.

- `since` (**required support**): return only payments with `occurred_at >= since`. We use it for incremental sync (we typically pull a rolling ~90 days).
- Ordering: any stable order is fine; `occurred_at` ascending preferred.

### Response

```json
{
  "count": 8123,
  "next": "https://api.example.com/api/qonshu/partners/142/payments?since=2026-04-16T00:00:00Z&page=2&page_size=500",
  "results": [
    {
      "external_id": "pay_558210",
      "external_user_id": "usr_10293",
      "occurred_at": "2026-07-14T09:21:00Z",
      "amount": 149.90,
      "method": "CARD",
      "category": "UTILITY"
    }
  ]
}
```

### Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `external_id` | string | recommended | Your stable unique id for the payment. Lets us de-duplicate safely. |
| `external_user_id` | string | **yes** | Must match a user's `external_id` from Endpoint 1. Payments whose user we don't know are skipped. |
| `occurred_at` | datetime | **yes** | When the payment happened (not when it was recorded, if those differ). Drives all date filtering + the trend chart. |
| `amount` | number | **yes** | Positive amount paid. |
| `method` | enum | **yes** | `CARD` \| `MANUAL` \| `CASH` — **how** it was paid. |
| `category` | enum | **yes** | `APARTMENT` \| `PARKING` \| `NON_RESIDENTIAL` \| `UTILITY` — **what** it was for. |

### Enum meanings (please confirm these match your domain)

**`method`**
- `CARD` — paid by bank card in the app
- `MANUAL` — recorded manually by an operator/admin
- `CASH` — paid in cash

**`category`**
- `APARTMENT` — residential apartment fees
- `PARKING` — parking fees
- `NON_RESIDENTIAL` — commercial/non-residential units
- `UTILITY` — utility bills

If your system has more categories or methods, **send us the full list** — we'd rather extend the enum than have you squash values into the wrong bucket. Refunds/reversals: tell us how you represent them (negative `amount`? a `status` field?) — we currently assume all rows are completed, positive payments.

---

## 7. Pagination

Standard DRF pagination is perfect:

```json
{ "count": 1342, "next": "<url|null>", "previous": "<url|null>", "results": [ ... ] }
```

We follow `next` until it's `null`. Page size up to ~500 is fine. If you prefer cursor pagination, that's fine too — just keep `next` as a full URL.

---

## 8. Errors

Use normal HTTP status codes with a JSON body:

```json
{ "detail": "Invalid or expired token." }
```

| Code | When |
|---|---|
| `401` | missing/invalid token |
| `403` | token valid but not allowed for this partner |
| `404` | unknown `partner_id` |
| `400` | bad params (e.g. malformed `since`) |
| `429` | rate limited — please include `Retry-After` |
| `5xx` | your side broke; we retry with backoff |

---

## 9. Idempotency & sync behaviour (important)

- We call these endpoints **repeatedly** (scheduled sync + a manual "Sync" button). They must be **safe to call often** and **side-effect free**.
- We **upsert users by `external_id`**. If an `external_id` changes for the same person, we will create a duplicate user — so please keep them stable.
- We refresh the payments window on each sync. Stable `external_id` on payments lets us de-duplicate reliably.
- Expected volume per partner: hundreds of users, thousands of payments per 90 days. If any partner is far larger, tell us and we'll adjust our paging/window.

---

## 10. What we compute from this (context, no action needed)

- **Installs**: users with `installed_at` set; split by `platform` (iOS/Android).
- **Activated / activation rate**: users with `last_login_at` set ÷ installs.
- **Users engaged**: distinct `external_user_id` with ≥1 payment in the selected period.
- **Payments**: count + amount for a period; breakdown by `method` and by `category`; daily trend; top users by amount paid.
- **Utility payments**: payments where `category = "UTILITY"`.
- **Total debt**: sum of `debt` across the partner's users.

---

## 11. Minimal acceptance checklist

- [ ] Base URLs for **staging** and **production**
- [ ] Auth scheme + a token for us (staging first)
- [ ] `GET .../users` returns the fields in §5, paginated
- [ ] `GET .../payments?since=…` returns the fields in §6, paginated, and **honours `since`**
- [ ] (Ideally) `GET /partners` returning `[{id, name}]` so we can map partners to CRM accounts
- [ ] Enum values confirmed (or your full list sent to us)
- [ ] Datetimes are ISO 8601 with timezone; amounts are 2-decimal numbers
- [ ] A sample response for one real partner from staging (even 2–3 rows) so we can validate our parser

---

## 12. Open questions for you

1. **Base URL + auth scheme** — what do we call, and how do we authenticate?
2. **Partner identifier** — what do we put in `{partner_id}`, and can you expose a partners list endpoint?
3. **`last_login_at`** — can you expose it? If not, can we rely on `app_token` presence?
4. **`app_token`** — is it a credential? If yes we'd rather have `has_app_token: true/false` (see §5).
5. **Names** — can you share real user names, or should they be masked?
6. **Enums** — do our `method` / `category` values match your domain exactly? Send your full lists if not.
7. **Refunds/cancellations** — how are they represented?
8. **Currency** — single currency per partner, or do we need a `currency` field?
9. **Volume** — rough users/payments per partner, and any rate limits we should respect.

Reply on these and we'll lock v1.1 of this contract, then wire it up — our side is already built against these shapes, so integration should be quick.
