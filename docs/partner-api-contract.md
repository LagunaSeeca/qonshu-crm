# Qonshu CRM — Partner API Contract

**Overview:** Qonshu CRM fetches analytics and property data from your system. We send a **partner company name** and **date range**, and you return statistics, payment details, and property structures for that partner.

---

## Authentication

All requests include the header:
```
X-API-Key: <per-partner-key>
```

The API key is **per-partner**, unique to each partner company, stored encrypted on our side, and never tied to any user login. Invalid or missing keys return `401`.

---

## Endpoints

### Endpoint 1: `GET /api/qonshu/partner-stats/`

**Query parameters:**

| Parameter | Example | Required | Notes |
|---|---|---|---|
| `partner` | `"Acme Towers"` | Yes | Partner company name. Unknown name → return `404`. |
| `date_from` | `2026-07-01` | Yes | Start of date range (inclusive, `YYYY-MM-DD`). |
| `date_to` | `2026-07-31` | Yes | End of date range (inclusive, `YYYY-MM-DD`). |
| `page` | `1` | No | Page number (default: 1, min: 1). |
| `page_size` | `100` | No | Items per page (default: 100, max: 500). |

**Partner matching:** Case-insensitive; ignore leading/trailing spaces. Treat company names as stable keys — renaming without notice breaks the partnership's analytics.

### Endpoint 2: `GET /api/qonshu/objects/`

**Query parameters:**

| Parameter | Example | Required | Notes |
|---|---|---|---|
| `partner` | `"Acme Towers"` | Yes | Partner company name. Unknown name → return `404`. |

Returns the property structure (buildings → blocks → units) for the partner's portfolio.

---

## Response: `GET /api/qonshu/partner-stats/`

### A. Users

| Field | Type | Meaning |
|---|---|---|
| `total_users` | number | All app users of this partner. |
| `active_users` | number | Users currently active in your system. |
| `engaged_users` | number | Users who made **at least one payment** in the date range. |
| `total_debt` | number | Total money owed by this partner's users right now (AZN). |

### B. Installations

| Field | Type | Meaning |
|---|---|---|
| `total_installations` | number | How many users installed the app. |
| `ios_installations` | number | Installed on iOS. |
| `android_installations` | number | Installed on Android. |
| `logged_in_users` | number | Users with an active app token (installed *and* logged in). |

### C. Payment totals & breakdowns

| Field | Type | Meaning |
|---|---|---|
| `total_payments_count` | number | Total number of payments in the range. |
| `total_payments_amount` | number | Total amount paid (AZN). |
| `amount_by_card` | number | Paid by card method. |
| `amount_by_manual` | number | Recorded manually. |
| `amount_by_cash` | number | Paid in cash. |
| `utility_payments_count` | number | Count of utility category payments. |
| `utility_payments_amount` | number | Total utility payments (AZN). |
| `apartment_payments_amount` | number | Total apartment payments (AZN). |
| `parking_payments_amount` | number | Total parking payments (AZN). |
| `property_payments_amount` | number | Total property (commercial) payments (AZN). |
| `office_payments_amount` | number | Total office payments (AZN). |

> **Amounts must sum:** The 5 category amounts (apartment + parking + property + office + utility) add up to `total_payments_amount`. The 3 method amounts (card + manual + cash) also add up to `total_payments_amount`.

### D. Payment categories

All 5 categories in the `category` field of payment objects:

- `APARTMENT` — residential units
- `PARKING` — parking spaces
- `PROPERTY` — commercial real estate (private properties)
- `OFFICE` — office units
- `UTILITY` — utilities (water, gas, electricity, etc.)

### E. Payment methods

All 3 methods in the `method` field of payment objects:

- `CARD` — card payment
- `MANUAL` — manually recorded
- `CASH` — cash payment

### F. Payments list (paginated)

The individual payments within the date range:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Your id for the payment. |
| `user_id` | string | Who paid. |
| `user_name` | string | User name or identifier. |
| `date` | string | ISO 8601 datetime (e.g. `2026-07-14T09:21:00Z`). |
| `amount` | number | Amount in AZN. |
| `method` | enum | `CARD`, `MANUAL`, or `CASH`. |
| `category` | enum | `APARTMENT`, `PARKING`, `PROPERTY`, `OFFICE`, or `UTILITY`. |

### G. Pagination metadata

| Field | Type | Meaning |
|---|---|---|
| `payments_page` | number | Current page number. |
| `payments_page_count` | number | Total number of pages. |
| `payments_total_count` | number | Total payment count across all pages. |
| `payments` | array | Paginated payment objects (see section F). |

> **Note:** Totals (sections A–D) always cover the **entire date range**, even when paginating. Only the `payments` array is paginated.

---

## Response: `GET /api/qonshu/objects/`

Returns the partner's property portfolio as a hierarchical tree:

```json
{
  "partner": "Acme Towers",
  "complex_type": "RESIDENTIAL",
  "buildings": [
    {
      "id": 1,
      "name": "Building A",
      "blocks": [
        {
          "id": 1,
          "name": "Block 1",
          "apartments": [
            {
              "id": 101,
              "apartment_number": "1-01",
              "owner_id": 5001,
              "owner_name": "John Doe",
              "owner_mobile": "+994551234567",
              "debt": 250.50,
              "balance": 100.00,
              "net": -150.50
            }
          ]
        }
      ],
      "parkings": [
        {
          "id": 201,
          "parking_number": "P-01",
          "owner_id": 5002,
          "owner_name": "Jane Smith",
          "owner_mobile": "+994551234568",
          "debt": 50.00,
          "balance": 50.00,
          "net": 0.00
        }
      ],
      "properties": [
        {
          "id": 301,
          "property_number": "COM-01",
          "type": "retail",
          "owner_id": 5003,
          "owner_name": "Commercial LLC",
          "owner_mobile": null,
          "debt": 500.00,
          "balance": 200.00,
          "net": -300.00
        }
      ],
      "offices": [
        {
          "id": 401,
          "office_number": "OFF-01",
          "owner_id": 5004,
          "owner_name": "Tech Startup",
          "owner_mobile": null,
          "debt": 150.00,
          "balance": 150.00,
          "net": 0.00
        }
      ]
    }
  ]
}
```

### Object structure

Each unit (apartment, parking, property, office) includes:

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Internal unit id. |
| `<type>_number` | string | User-facing unit number (apartment_number, parking_number, property_number, office_number). |
| `owner_id` | number \| null | ID of the current owner, or `null` if unassigned. |
| `owner_name` | string \| null | Owner name, or `null` if unassigned. |
| `owner_mobile` | string \| null | Owner mobile number, or `null` if not provided. |
| `debt` | number | Amount owed by owner (AZN). |
| `balance` | number | Account balance (AZN). |
| `net` | number | `balance - debt` (AZN). |

### Building & block structure

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Building/block id. |
| `name` | string | Building/block name. |
| `blocks` | array | (Buildings only) Array of blocks within. |
| `apartments` | array | Array of apartment objects within (block or building). |
| `parkings` | array | Array of parking objects (building level only). |
| `properties` | array | Array of property/commercial objects (building level only). |
| `office` | array | Array of office objects (building level only). |

### Root response

| Field | Type | Meaning |
|---|---|---|
| `partner` | string | Partner company name. |
| `complex_type` | enum | `RESIDENTIAL` or `COMMERCIAL`. |
| `buildings` | array | Array of building objects. |

---

## Examples

### Example 1: Partner stats (paginated)

**Request**
```
GET /api/qonshu/partner-stats/?partner=Acme+Towers&date_from=2026-07-01&date_to=2026-07-31&page=1&page_size=100
Header: X-API-Key: sk_partner_acme_xyz
```

**Response (200 OK)**
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
  "property_payments_amount": 9000.00,
  "office_payments_amount": 2100.00,

  "payments_page": 1,
  "payments_page_count": 32,
  "payments_total_count": 3120,
  "payments": [
    {
      "id": "pay_558210",
      "user_id": "usr_10293",
      "user_name": "Aysel Mammadova",
      "date": "2026-07-14T09:21:00Z",
      "amount": 149.90,
      "method": "CARD",
      "category": "UTILITY"
    },
    {
      "id": "pay_558211",
      "user_id": "usr_10294",
      "user_name": "Elgun Aliyev",
      "date": "2026-07-15T10:15:00Z",
      "amount": 275.50,
      "method": "MANUAL",
      "category": "APARTMENT"
    }
  ]
}
```

### Example 2: Unknown partner (404)

**Request**
```
GET /api/qonshu/partner-stats/?partner=Unknown+Company&date_from=2026-07-01&date_to=2026-07-31
Header: X-API-Key: sk_partner_acme_xyz
```

**Response (404)**
```json
{ "error": "Partner not found" }
```

### Example 3: Invalid API key (401)

**Request**
```
GET /api/qonshu/partner-stats/?partner=Acme+Towers&date_from=2026-07-01&date_to=2026-07-31
Header: X-API-Key: invalid_key
```

**Response (401)**
```json
{ "error": "Unauthorized" }
```

### Example 4: Objects endpoint

**Request**
```
GET /api/qonshu/objects/?partner=Acme+Towers
Header: X-API-Key: sk_partner_acme_xyz
```

**Response (200 OK)**
```json
{
  "partner": "Acme Towers",
  "complex_type": "RESIDENTIAL",
  "buildings": [
    {
      "id": 1,
      "name": "Tower A",
      "blocks": [
        {
          "id": 101,
          "name": "Block 1-North",
          "apartments": [
            {
              "id": 1001,
              "apartment_number": "101",
              "owner_id": 5001,
              "owner_name": "Aysel Mammadova",
              "owner_mobile": "+994551234567",
              "debt": 250.50,
              "balance": 100.00,
              "net": -150.50
            }
          ]
        }
      ],
      "parkings": [
        {
          "id": 2001,
          "parking_number": "P-001",
          "owner_id": 5002,
          "owner_name": "Elgun Aliyev",
          "owner_mobile": "+994551234568",
          "debt": 50.00,
          "balance": 75.00,
          "net": 25.00
        }
      ],
      "properties": [],
      "offices": []
    }
  ]
}
```

---

## Error responses

| Status | Meaning |
|---|---|
| `200` | Success. |
| `401` | Invalid or missing `X-API-Key` header. |
| `404` | Unknown partner name. |
| `500` | Server error. |

---

## Data format

- **Dates in range:** `YYYY-MM-DD` (e.g. `2026-07-01`)
- **Timestamps:** ISO 8601 with UTC (e.g. `2026-07-14T09:21:00Z`)
- **Money:** Positive numbers with 2 decimals (e.g. `149.90`). Currency is **AZN**. No refunds or negative amounts.
- **Names:** Allow Unicode; trim whitespace on match.

## Data integrity rules

- **Cancelled payments:** Must be excluded from `payments` list and all totals (handled on your side).
- **No data for range:** Return the same structure with `0` totals and an empty `payments` list — not an error.
- **Sums must balance:**
  - `utility + apartment + parking + property + office = total_payments_amount`
  - `card + manual + cash = total_payments_amount`
- **Read-only endpoint:** All operations are queries only; no writes, no state changes.
- **Repeat-safe:** The CRM fetches repeatedly; corrections and cancellations on your side appear automatically on the next call.

---

## Integration approach

Qonshu CRM uses a **server-side proxy** pattern:

```
Browser → Next.js API proxy → Django Partner API
           (fetches live per request)
```

- The `X-API-Key` is **stored encrypted** in the Qonshu database, accessible only by the server.
- API keys **never** reach the browser; all calls are proxied through our Next.js server.
- We **do not cache or persist** API business data (payment details, user counts, etc.). All data is fetched fresh on each request.
- Only the encrypted key, partner name, and manually-entered installation counts live in our database.

This approach keeps your API key secure and ensures analytics are always current.

---

## Agreed decisions

| Question | Decision |
|---|---|
| Payment methods | **Confirmed** — `CARD`, `MANUAL`, `CASH` |
| Payment categories | **Confirmed** — `APARTMENT`, `PARKING`, `PROPERTY`, `OFFICE`, `UTILITY` (5 total) |
| Pagination | **Yes** — `page` and `page_size` query params; totals remain complete across pages |
| Objects endpoint | **Yes** — hierarchical buildings → blocks → apartments; parkings/properties/offices flat |
| Logged-in users | **Yes** — count of users holding an active app token |
| Refunds | **None exist** — all amounts are positive |
| Cancelled payments | Handled on your side; excluded from responses. CRM auto-updates on next call. |
| Partner identifier | **Company name** (no numeric id); entered manually — keep names stable and exact |
| Currency | **AZN** for all amounts |
