# Deploying to AWS EC2

## Why EC2 and not S3?

S3 static website hosting can only serve files (HTML/CSS/JS). This app is a
Django server: it runs Python on every request, talks to a SQLite database,
scrapes websites, and calls the Anthropic API. None of that can execute on
S3, so the app itself must run on a compute service — EC2 is the simplest.
(S3 can still be added later for user-uploaded media or backups; static
assets are already handled by WhiteNoise, so no bucket is needed for those.)

Architecture:

```
Browser ── HTTP(S) ──> nginx (port 80/443, on EC2)
                          └──> gunicorn (127.0.0.1:8000)
                                  └──> Django app ──> SQLite (/var/lib/privacy-tracker/)
                                                 └──> Anthropic API
```

## One-time EC2 setup

1. **Launch an instance** — Ubuntu 24.04, t3.micro is fine to start.
   - Security group: allow inbound TCP 80/443 (anywhere). **Port 22 is not
     needed** — deploys and shell access both go through AWS SSM, so leave
     SSH closed entirely.
   - Tag the instance `Name=privacy-tracker` (the deploy workflow finds it
     by this tag).
   - Attach an IAM instance profile that has the AWS-managed policy
     `AmazonSSMManagedInstanceCore` (IAM → Roles → Create role → trusted
     entity "EC2" → attach that policy). The SSM agent is preinstalled on
     Ubuntu AMIs, so nothing to install.

   For an interactive shell instead of SSH, use Session Manager:

   ```bash
   aws ssm start-session --target <instance-id>
   # or the "Connect" button → "Session Manager" tab in the EC2 console
   ```

2. **Install system packages:**

   ```bash
   sudo apt update && sudo apt install -y python3-venv nginx git
   ```

3. **Clone the repo and create the venv:**

   ```bash
   sudo mkdir -p /opt/privacy-tracker && sudo chown ubuntu:ubuntu /opt/privacy-tracker
   cd /opt/privacy-tracker
   git clone https://github.com/Tempestous15/privacy_policy_tracker.git
   cd privacy_policy_tracker/website
   python3 -m venv .venv
   ./.venv/bin/pip install -r requirements.txt
   ```

4. **Create the database directory and environment file:**

   ```bash
   sudo mkdir -p /var/lib/privacy-tracker && sudo chown ubuntu:ubuntu /var/lib/privacy-tracker
   sudo tee /etc/privacy-tracker.env > /dev/null <<'EOF'
   DJANGO_SECRET_KEY=<output of: python3 -c "import secrets; print(secrets.token_urlsafe(50))">
   DJANGO_DEBUG=false
   DJANGO_ALLOWED_HOSTS=<your-domain-or-ec2-public-dns>
   DJANGO_CSRF_TRUSTED_ORIGINS=http://<your-domain-or-ec2-public-dns>
   DJANGO_DB_PATH=/var/lib/privacy-tracker/db.sqlite3
   ANTHROPIC_API_KEY=<your key, or omit to run in mock mode>
   EOF
   sudo chown root:ubuntu /etc/privacy-tracker.env
   sudo chmod 640 /etc/privacy-tracker.env
   ```

   (Group-readable by `ubuntu` so `deploy/deploy.sh` can source it when
   running `manage.py migrate` / `collectstatic` as that user.)

   After enabling HTTPS (step 7), change the CSRF origin to `https://...`.

5. **Migrate, collect static files, create an admin user:**

   ```bash
   set -a && source /etc/privacy-tracker.env && set +a
   ./.venv/bin/python manage.py migrate
   ./.venv/bin/python manage.py collectstatic --noinput
   ./.venv/bin/python manage.py createsuperuser
   ```

6. **Install the systemd service and nginx config** (files in `deploy/`):

   ```bash
   cd /opt/privacy-tracker/privacy_policy_tracker
   sudo cp deploy/privacy-tracker.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now privacy-tracker

   sudo cp deploy/nginx-privacy-tracker.conf /etc/nginx/sites-available/privacy-tracker
   sudo ln -s /etc/nginx/sites-available/privacy-tracker /etc/nginx/sites-enabled/
   sudo rm -f /etc/nginx/sites-enabled/default
   sudo nginx -t && sudo systemctl reload nginx
   ```

   The site should now be reachable at `http://<ec2-public-dns>/`.

7. **HTTPS (optional but recommended, needs a domain):**

   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d yourdomain.com
   ```

## Automatic deploys (GitHub Actions, keyless)

`.github/workflows/deploy.yml` runs on every push to `main` that touches
`website/` or `deploy/`. **No permanent credentials are stored in GitHub**:
the workflow authenticates with GitHub's OIDC identity provider, assumes a
short-lived AWS role, and executes `deploy/deploy.sh` on the instance via
SSM Run Command — no SSH keys, no open port 22, nothing to rotate or leak.

One-time IAM setup:

1. **OIDC identity provider** (skip if it already exists in the account —
   it does if the old S3 deploy role was set up): IAM → Identity providers
   → Add provider → OpenID Connect, provider URL
   `https://token.actions.githubusercontent.com`, audience
   `sts.amazonaws.com`.

2. **Deploy role** — create `GitHubActions-EC2-DeployRole` with this trust
   policy, which only allows workflows from this repo's `main` branch to
   assume it (replace the account ID if different):

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

3. **Permissions policy** on that role — scoped to running the standard
   shell-script document on instances tagged `privacy-tracker` only:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "ec2:DescribeInstances",
         "Resource": "*"
       },
       {
         "Effect": "Allow",
         "Action": "ssm:SendCommand",
         "Resource": "arn:aws:ec2:us-east-1:131031217080:instance/*",
         "Condition": {
           "StringEquals": { "aws:ResourceTag/Name": "privacy-tracker" }
         }
       },
       {
         "Effect": "Allow",
         "Action": "ssm:SendCommand",
         "Resource": "arn:aws:ssm:us-east-1::document/AWS-RunShellScript"
       },
       {
         "Effect": "Allow",
         "Action": "ssm:GetCommandInvocation",
         "Resource": "*"
       }
     ]
   }
   ```

4. If the role name, account ID, region, or instance tag differ from the
   defaults, update the `env:` block at the top of
   `.github/workflows/deploy.yml`. (A role ARN is not a secret — the trust
   policy above is what controls who can use it.)

The old `GitHubActions-S3-DeployRole` from the retired S3 workflow can be
deleted, along with any `EC2_*` repository secrets if they were created.

## Useful commands on the server

```bash
sudo systemctl status privacy-tracker      # is the app running?
sudo journalctl -u privacy-tracker -f      # tail app logs
sudo systemctl restart privacy-tracker     # restart after manual changes
```
