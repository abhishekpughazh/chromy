# Chromy

An interactive karyotype assembly tool for cytogeneticists to learn and practice chromosome identification.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/abhishekpughazh/chromy.git
cd chromy
```

### 2. Install Node dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in your Supabase project URL and anon key.

### 4. Configure auth email (Resend)

Supabase's default auth email sender is heavily rate-limited. To allow more signups, connect [Resend](https://resend.com) as your email provider.

See **[docs/RESEND_SETUP.md](docs/RESEND_SETUP.md)** for step-by-step instructions (SMTP integration or Edge Function).

### 5. Run the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.
