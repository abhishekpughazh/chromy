# Chromy

An interactive karyotype assembly tool for cytogeneticists to learn and practice chromosome identification.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Python](https://www.python.org/) 3.12+

## Setup

### 1. Clone the repo

```bash
git clone https://repos.roswellpark.org/ab55604/chromy_v1.git
cd chromy_v1
```

### 2. Install Node dependencies

```bash
npm install
```

### 3. Set up the Python environment

```bash
python3 -m venv .venv
source .venv/bin/activate        # macOS/Linux
# .venv\Scripts\activate         # Windows

pip install torch Pillow realesrgan basicsr opencv-python numpy
```

### 4. Run the app

In one terminal, start the backend:

```bash
npm run server
```

In a second terminal, start the frontend:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.
