# `0001_init.sql` — apply করার আগে যা সিদ্ধান্ত দরকার

> **অবস্থা:** ফাইল লেখা ও যাচাই করা হয়েছে — ৪২ টেবিল, ৬৪ index, ৯টি settings seed, কোনো FK ভাঙা নেই, ছয়টি CHECK নিয়ম আসলেই কাজ করে (SQLite 3.45.1-এ চালিয়ে দেখা)।
> **জরুরি:** একবার `wrangler d1 migrations apply --remote` চালালে এই ফাইল **চিরতরে immutable** (ADR-028)। তারপর প্রতিটি ছোট যোগের জন্যও নতুন ADR + নতুন migration লাগবে। তাই নিচের সিদ্ধান্তগুলো **এখনই** দরকার।

---

## ১. দুটো সংযোজন যেগুলো আমি সুপারিশ করি

### ক) পাইপলাইন স্লাইস — outreach-এর পরে কী হয়, সেটা এখন কোথাও লেখা নেই

আজকের `leads.status` enum-এ `replied` আছে, কিন্তু তারপরের ধাপ (`interested`, `call booked`, `proposal`, `won`) কোথাও নেই। অর্থাৎ "আজ কোন লিডে হাত দিতে হবে" প্রশ্নের উত্তর সিস্টেমে থাকে না।

```sql
-- leads-এ যোগ হবে (0001-এ সরাসরি, তাই ALTER লাগবে না)
  stage             TEXT NOT NULL DEFAULT 'new'
                      CHECK (stage IN ('new','researched','qualified','contacted','replied','interested',
                                       'call_booked','call_done','proposal','negotiation','won','lost')),
  next_follow_up_at INTEGER,
  lost_reason       TEXT CHECK (lost_reason IN ('not_interested','bad_fit','no_response','budget',
                                                'timing','competitor','lost')),

-- নতুন append-only টেবিল
CREATE TABLE stage_events (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL REFERENCES leads(id),
  from_stage TEXT,
  to_stage   TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'user',
  note       TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_stage_events_lead ON stage_events(lead_id, created_at);

-- খালি থাকবে; won হলে এক লিড থেকে এক সারি
CREATE TABLE clients (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT REFERENCES leads(id),
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','churned')),
  started_at  INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
```

**তবে এটা canonical নথিতে নেই** — তাই আমি চুপচাপ যোগ করিনি। যোগ করতে চাইলে আগে **একটা ADR** লেখা উচিত (`04-decisions.md`-এ ADR-040), তারপর বসানো। ইনভয়েস/প্রজেক্ট **নয়** — ওটা ADR-024-এ বাদই থাকবে।

### খ) `language` ও `timezone`

আউটরিচ কখন পাঠাবে আর কোন ভাষায়, সেটা ঠিক করতে দুটো দরকার। `05-schema.md`-এ এদের উল্লেখ পাইনি (নথি অসম্পূর্ণও হতে পারে)। না থাকলে:

```sql
  language  TEXT,          -- BCP-47, যেমন 'en', 'bn'
  timezone  TEXT,          -- IANA, যেমন 'America/Chicago'
```

`geo_targets` থেকেও আন্দাজ করা যায়, কিন্তু প্রতিটি লিডে আলাদা করে আন্দাজ করা মানে outreach scheduler-এ ভুল সময়ে পাঠানোর ঝুঁকি।

## ২. DDL লিখতে গিয়ে যে তিনটি নথি-সংঘর্ষ হাতে-হাতে ধরা পড়ল

| # | সংঘর্ষ | আমি যা করেছি |
|---|---|---|
| ১ | **`route_attempts`-এর কলাম দুই ফাইলে দুই রকম** — `05 §21`-এ ১৪টি, `09 §10`-এ ১৯টি (`adapter`, `source_id`, `records_count`, `unit_type`, `units`, `circuit_scope`, `score`, `note` বাড়তি) | `05` canonical ধরে লিখেছি (নামের দ্বন্দ্বে `05` জেতার নিয়ম মেনে)। **কিন্তু ০৯-এর ৮টি কলাম আসলে কাজে লাগে** — বিশেষত `circuit_scope` (কোন স্তরে সার্কিট খুলেছিল) আর `score` (কেন এই provider বাছা হলো); নাহলে ০৯ §১০-এর নিজের "পরে ব্যাখ্যা করা যাবে" প্রতিশ্রুতিটাই রক্ষা হয় না। → **সিদ্ধান্ত দরকার** |
| ২ | **`job_queue.status`-এ `needs_manual` নেই** — `09 §9` বলে ৩ হপ শেষে `status='needs_manual'`, কিন্তু `05 §19`-এর enum-এ ওই মান নেই (`pending,claimed,running,done,failed,dead`) | `05` মেনে ৬টি মান রেখেছি। প্রশ্ন: "manual check needed" কীভাবে বোঝাবে — `failed` + `last_error`, নাকি enum-এ সপ্তম মান? |
| ৩ | **`settings.d1_daily_write_ceiling`-এর কোনো মান কোথাও লেখা নেই** | কলামটি seed করা আছে কিন্তু মান **NULL** — অনুমান করে বসাইনি। STEP 5-এ scheduler চালু করার আগে ঠিক করে একটা `UPDATE` দরকার |

(আগের তালিকার `§0`-এ "৪৩" বনাম `§L`-এর "৪২" — এটা মিটে গেছে: **৪২টি `CREATE TABLE`** লিখেছি, যা `§L` ও `03 STEP 2`-এর সাথে মেলে।)

## ৩. যা ইচ্ছাকৃতভাবে **লিখিনি**

- `manual_sources` টেবিল — ADR-038-এ বাদ, Class C/X এখন `directory_sources.class`-এ
- `block_reason` টেবিল — ওটা একটা কলামের enum (`§9`)
- কোনো `users` টেবিল — auth পুরোটাই Cloudflare Access-এর হাতে
- Yelp-এর কোনো content কলাম — শুধু `leads.yelp_business_id`
- কোনো `FLOAT` টাকা, কোনো `bd_*` prefix, কোনো `0002_*.sql`

## ৪. পরের ধাপ

1. **এই দুটো সংযোজন + তিনটি সিদ্ধান্ত** — তারপর `0001` freeze
2. `seed.sql` (STEP 3): provider capability matrix · ৮টি Class C · ১টি Class X · `score_weights` v1
3. `wrangler d1 create` → `migrations apply --local` → তারপর `--remote`
