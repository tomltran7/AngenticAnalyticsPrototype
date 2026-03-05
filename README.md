# Agentic Claims Analytics (Excel-backed)

Local React app that uses an **Excel workbook (.xlsx)** as a temporary "backend" to drive a claims dashboard + (optional) lightweight agent logic.

## Quick start
```bash
npm install
npm run dev
```

## Put your workbook here
- Place your workbook at: `public/claims.xlsx`
- The app will attempt to auto-load it at startup.

This project zip includes your workbook copied into `public/claims.xlsx` if it was present in the sandbox.

## Run tests
```bash
npm test
```
