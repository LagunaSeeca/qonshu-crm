# Qonshu CRM — what we need from the app API

**How it works:** we send you a **partner company** and a **date range**. You return that partner's numbers for that range.

---

## Request

`GET /api/qonshu/partner-stats`

| We send | Example | Notes |
|---|---|---|
| `partner` | `"Acme Towers"` | The partner company. A stable **id** is better than a name — if you have one, we'll use it. |
| `date_from` | `2026-07-01` | Start of the range (inclusive). |
| `date_to` | `2026-07-31` | End of the range (inclusive). |

---

## Response — what you return

### A. Users

| Field | Type | Meaning |
|---|---|---|
| `total_users` | number | All app users of this partner. |
| `active_users` | number | Users currently active in your system. |
| `engaged_users` | number | Users who made **at least one payment** in the date range. |
| `total_debt` | number | Total money owed by this partner's users right now. |

### B. Installations

| Field | Type | Meaning |
|---|---|---|
| `total_installations` | number | How many users installed the app. |
| `ios_installations` | number | Installed on iOS. |
| `android_installations` | number | Installed on Android. |
| `logged_in_users` | number | Installed **and** logged in at least once (proves real usage). |

### C. Payments in the date range

| Field | Type | Meaning |
|---|---|---|
| `total_payments_count` | number | How many payments were made. |
| `total_payments_amount` | number | Total money paid. |
| `amount_by_card` | number | Of that total, paid by card. |
| `amount_by_manual` | number | Of that total, recorded manually. |
| `amount_by_cash` | number | Of that total, paid in cash. |
| `utility_payments_count` | number | How many utility payments. |
| `utility_payments_amount` | number | Total utility amount. |
| `apartment_payments_amount` | number | Total for apartments. |
| `parking_payments_amount` | number | Total for parking. |
| `non_residential_payments_amount` | number | Total for non-residential units. |

> The four category amounts (utility / apartment / parking / non-residential) should add up to `total_payments_amount`. Same for the three method amounts (card / manual / cash).

### D. Payments list

The individual payments in that date range, so we can show the transactions table:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Your id for the payment. |
| `user_id` | string | Who paid. |
| `user_name` | string | Their name (or a label). |
| `date` | datetime | When the payment happened. |
| `amount` | number | How much. |
| `method` | `CARD` / `MANUAL` / `CASH` | How they paid. |
| `category` | `APARTMENT` / `PARKING` / `NON_RESIDENTIAL` / `UTILITY` | What they paid for. |

---

## Full example

**Request**
```
GET /api/qonshu/partner-stats?partner=Acme+Towers&date_from=2026-07-01&date_to=2026-07-31
```

**Response**
```json
{
  "partner": "Acme Towers",
  "date_from": "2026-07-01",
  "date_to": "2026-07-31",

  "total_users": 1342,
  "active_users": 1180,
  "engaged_users": 640,
  "total_debt": 18420.75,

  "total_installations": 1200,
  "ios_installations": 520,
  "android_installations": 680,
  "logged_in_users": 900,

  "total_payments_count": 3120,
  "total_payments_amount": 154300.50,
  "amount_by_card": 120400.00,
  "amount_by_manual": 21900.50,
  "amount_by_cash": 12000.00,

  "utility_payments_count": 810,
  "utility_payments_amount": 39200.00,
  "apartment_payments_amount": 82100.50,
  "parking_payments_amount": 21000.00,
  "non_residential_payments_amount": 12000.00,

  "payments": [
    {
      "id": "pay_558210",
      "user_id": "usr_10293",
      "user_name": "Aysel Mammadova",
      "date": "2026-07-14T09:21:00Z",
      "amount": 149.90,
      "method": "CARD",
      "category": "UTILITY"
    }
  ]
}
```

---

## Format notes

- Dates: ISO format — `2026-07-14T09:21:00Z` for times, `2026-07-01` for the range.
- Money: number with 2 decimals — `149.90`.
- If a partner has no data for the range: return the same structure with `0`s and an empty `payments` list (not an error).
- If the `payments` list is very long, paginate it — but keep the totals above complete for the whole range.

## Please confirm

1. Do the **method** values (card / manual / cash) and **category** values (apartment / parking / non-residential / utility) match your system? If you have more, send the full list.
2. Can you give us **`logged_in_users`** (installed *and* logged in)? That's how we measure real usage, not just downloads.
3. How do you handle **refunds / cancelled payments** — are they excluded, or sent as negative amounts?
4. Do you have a **partner id** we should send instead of the company name?
5. Can you also give us a **list of partners** (`id` + `name`), so we can match them to our records?
