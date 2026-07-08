#!/usr/bin/env bash
# Runs on the EC2 instance (as root, via SSM Run Command) after the checkout
# at /opt/privacy-tracker/privacy_policy_tracker has been updated to the
# latest main. Installs deps, migrates, collects static files, restarts the
# app. App-level steps run as the ubuntu user so file ownership matches the
# gunicorn service.
set -euo pipefail

APP_DIR=/opt/privacy-tracker/privacy_policy_tracker/website

runuser -u ubuntu -- "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt"

# manage.py needs the production env (secret key, DB path, DEBUG=false);
# /etc/privacy-tracker.env is root:ubuntu 640 so the ubuntu user can read it.
runuser -u ubuntu -- bash -c "
  set -euo pipefail
  set -a && source /etc/privacy-tracker.env && set +a
  cd '$APP_DIR'
  ./.venv/bin/python manage.py migrate --noinput
  ./.venv/bin/python manage.py collectstatic --noinput
"

systemctl restart privacy-tracker
systemctl is-active privacy-tracker
