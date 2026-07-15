# Deploying the website to S3

## What this is

`website/` is a plain static site — `index.html`, `mission.html`, `privacy.html`,
and `assets/style.css`. No server, no database, no build step. It exists purely as
a marketing/landing page pointing people at the browser extension, which is where
all of the product's actual functionality lives (runs entirely client-side — see
`extension/README.md` and the extension's own privacy policy content).

This is *not* a general "any Django app can move to S3" pattern — it works here
specifically because the site has no server-side logic left at all. S3 static
website hosting only serves files; it can't run application code.

## One-time S3 setup

1. **Create the bucket** (name must match what's in `.github/workflows/deploy.yml`,
   currently `privacy-policy-tracker-website`):

   ```bash
   aws s3 mb s3://privacy-policy-tracker-website --region us-east-1
   ```

2. **Enable static website hosting** on the bucket, with `index.html` as both the
   index and error document (a single-page-ish marketing site doesn't need a
   separate 404 page):

   ```bash
   aws s3 website s3://privacy-policy-tracker-website \
     --index-document index.html --error-document index.html
   ```

3. **Allow public read access.** Static website hosting requires the objects (or
   the bucket) to be publicly readable — there's no way around this for a public
   marketing page. Either:
   - Turn off "Block all public access" for this bucket in the console, and attach
     a bucket policy granting `s3:GetObject` to `"Principal": "*"`, or
   - Put a CloudFront distribution in front of the bucket instead (recommended if
     you also want HTTPS on a custom domain — S3 website endpoints are HTTP-only)
     using an Origin Access Control, which keeps the bucket itself private.

4. **Note the endpoint.** The plain S3 website endpoint is
   `http://privacy-policy-tracker-website.s3-website-us-east-1.amazonaws.com`
   (region-specific — adjust if not `us-east-1`). Point a custom domain at this
   (or at a CloudFront distribution in front of it) via CNAME/ALIAS if desired.

## Automatic deploys (GitHub Actions, keyless)

`.github/workflows/deploy.yml` runs on every push to `main` that touches
`website/`. It authenticates via GitHub's OIDC identity provider and assumes a
short-lived AWS role to run `aws s3 sync` — no long-lived AWS credentials stored
in GitHub.

One-time IAM setup:

1. **OIDC identity provider** (skip if it already exists in the account): IAM →
   Identity providers → Add provider → OpenID Connect, provider URL
   `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.

2. **Deploy role** — create `GitHubActions-S3-DeployRole` with this trust policy
   (only allows workflows from this repo's `main` branch to assume it; replace the
   account ID if different):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": {
         "Federated": "arn:aws:iam::131031217080:oidc-provider/token.actions.githubusercontent.com"
       },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
         "StringLike": { "token.actions.githubusercontent.com:sub": "repo:Tempestous15/privacy_policy_tracker:ref:refs/heads/main" }
       }
     }]
   }
   ```

3. **Permissions policy** on that role — scoped to just this bucket:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
         "Resource": [
           "arn:aws:s3:::privacy-policy-tracker-website",
           "arn:aws:s3:::privacy-policy-tracker-website/*"
         ]
       }
     ]
   }
   ```

4. Update the `role-to-assume` ARN and `aws-region` in
   `.github/workflows/deploy.yml` if the role name, account ID, or region differ.
   (A role ARN is not a secret — the trust policy above is what controls who can
   use it.)

## Testing locally

No server needed — any static file server works:

```bash
cd website && python3 -m http.server 8000
```

Then visit `http://localhost:8000/`.
