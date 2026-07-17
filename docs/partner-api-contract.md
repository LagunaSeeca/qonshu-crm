# Data Qonshu CRM needs from the app API

We need **two lists per partner**: their **app users**, and the **payments** those users made in the app. Read-only — we never write anything back.

---

## 1. App users

One row per app user of that partner.

| Field | Type | Meaning |
|---|---|---|
| `external_id` | string | Your unique id for the user. Must never change. |
| `name` | string | User's name (or a label like `Apt 12B` if names can't be shared). |
| `active` | boolean | Is the user active in your system? |
| `debt` | number | How much this user currently owes (0 if nothing). |
| `joined_at` | datetime | When the user registered. |
| `platform` | `IOS` / `ANDROID` / `UNKNOWN` | Which app they installed. |
| `installed_at` | datetime or null | When they installed the app. null = never installed. |
| `last_login_at` | datetime or null | Last time they logged into the app. null = never logged in. |

Example:
```json
{
  "external_id": "usr_10293",
  "name": "Aysel Mammadova",
  "active": true,
  "debt": 120.50,
  "joined_at": "2025-11-03T08:14:00Z",
  "platform": "IOS",
  "installed_at": "2025-11-03T08:10:00Z",
  "last_login_at": "2026-07-14T19:02:11Z"
}
```

---

## 2. Payments

One row per payment a user made through the app.

| Field | Type | Meaning |
|---|---|---|
| `external_id` | string | Your unique id for the payment. |
| `external_user_id` | string | Which user paid — must match a user's `external_id` above. |
| `occurred_at` | datetime | When the payment happened. |
| `amount` | number | Amount paid. |
| `method` | `CARD` / `MANUAL` / `CASH` | How they paid. |
| `category` | `APARTMENT` / `PARKING` / `NON_RESIDENTIAL` / `UTILITY` | What they paid for. |

Example:
```json
{
  "external_id": "pay_558210",
  "external_user_id": "usr_10293",
  "occurred_at": "2026-07-14T09:21:00Z",
  "amount": 149.90,
  "method": "CARD",
  "category": "UTILITY"
}
```

---

## Format notes

- Dates: ISO 8601 with timezone — `2026-07-14T09:21:00Z`
- Money: number with 2 decimals — `149.90`
- Payments endpoint should accept a `since` date so we can fetch only new payments.
- Each list is per partner, so we need a partner id in the request (and ideally a list of partners with their ids and names).

## Please confirm

- Do the `method` and `category` values match your system? If you have more, send us the full list.
- Can you provide `last_login_at`? We use it to see who actually installed **and** logged in.
- How do you represent refunds/cancelled payments?
