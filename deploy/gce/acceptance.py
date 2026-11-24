"""Run only against disposable DBL Campus instances containing synthetic records."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import getpass
import json
import os
from pathlib import Path
import secrets
import statistics
import subprocess
import time
from urllib.parse import urlsplit


ATTACHMENT = b"DBL Campus infrastructure acceptance fixture\n"


class Campus:
    def __init__(self, origin):
        self.origin = origin

    def call(self, route, payload=None, token=None, raw=False):
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        config = []
        if payload is not None:
            headers["Content-Type"] = "application/json"
            config.append("data-binary = " + json.dumps(json.dumps(payload)))
        config.extend("header = " + json.dumps(f"{key}: {value}") for key, value in headers.items())
        # Use the deployment's HTTP client. Keep credentials and request bodies off argv.
        # curl does not follow redirects unless asked to do so.
        result = subprocess.run(
            ["curl", "-q", "-sS", "--max-time", "10", "--proto", "=http,https",
             "--write-out", "\n%{http_code}\t%header{cf-ray}\t%header{cf-mitigated}",
             "--config", "-", "--", self.origin + route],
            input=("\n".join(config) + "\n").encode(), capture_output=True,
        )
        if result.returncode:
            raise RuntimeError(f"curl failed on {route} with exit code {result.returncode}")
        body, _, response = result.stdout.rpartition(b"\n")
        status, ray, mitigated = response.decode().split("\t")
        if not status.startswith("2"):
            details = f"HTTP {status} on {route}"
            if ray:
                details += f" (Cloudflare Ray {ray})"
            if mitigated == "challenge":
                details += ": Cloudflare challenge"
            raise RuntimeError(details)
        return body if raw else json.loads(body)

    def preflight(self):
        health = self.call("/api/health")
        assert health["status"] == health["database"] == "ok"
        assert health["storageWritable"] and health["httpsEnforced"] and not health["demoEnabled"]
        assert self.call("/manifest.webmanifest")["display"] == "standalone"
        assert self.call("/sw.js", raw=True)

    def login(self, identity, role):
        account = self.call("/api/auth/login",
                            {"identifier": identity["universityId"], "password": identity["password"]})
        assert account["user"]["role"] == role
        return account["token"]


def identity(role, suffix):
    return {"universityId": "synthetic-" + role + "-" + suffix, "fullName": "Synthetic " + role,
            "email": role + "-" + suffix + "@example.invalid", "password": secrets.token_urlsafe(24),
            "groupName": "A"}


def setup(campus, representative):
    assert campus.call("/api/auth/status")["hasProductionRepresentative"] is False, (
        "Choose an empty disposable acceptance instance"
    )
    code = os.environ.get("CAMPUS_ACCEPTANCE_SETUP_CODE") or getpass.getpass("Acceptance setup code: ")
    return campus.call("/api/auth/setup-production-rep", {**representative, "setupCode": code})["user"]["id"]


def write_private(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        json.dump(value, file)


def seed(campus, state_path, backup_path):
    suffix = secrets.token_hex(4)
    representative = identity("representative", suffix)
    student = identity("student", suffix)
    rep_id = setup(campus, representative)
    rep = campus.login(representative, "representative")
    campus.call("/api/users", student, rep)
    token = campus.login(student, "student")
    course = campus.call("/api/courses", {"code": "QA-" + suffix, "nameAr": "مقرر اختباري",
                                        "instructor": "Synthetic instructor"}, rep)
    file = campus.call("/api/files", {"courseId": course["id"], "title": "Synthetic attachment",
                                     "fileName": "fixture.txt", "mimeType": "text/plain",
                                     "base64Content": base64.b64encode(ATTACHMENT).decode()}, rep)
    request = campus.call("/api/requests", {"subject": "Synthetic request", "details": "Acceptance test",
                                           "targetAuthority": "Test office", "isCollective": True,
                                           "requestType": "request"}, rep)
    campus.call("/api/requests/" + request["id"] + "/endorse", {}, token)
    state = {"representative": representative, "representativeId": rep_id, "student": student,
             "request": request["id"], "file": file["id"]}
    verify(campus, state)
    backup = campus.call("/api/admin/backup", token=rep)
    assert backup["tables"]["library_files"] and backup["attachments"]
    write_private(state_path, state)
    write_private(backup_path, backup)


def verify(campus, state):
    campus.login(state["representative"], "representative")
    token = campus.login(state["student"], "student")
    assert campus.call("/api/files/" + state["file"] + "/download", token=token, raw=True) == ATTACHMENT
    request = next(row for row in campus.call("/api/requests", token=token) if row["id"] == state["request"])
    # The creator endorses on behalf of their own account at creation.
    assert request["userHasEndorsed"] and request["endorsementCount"] == 2
    assert request["assignedTo"] == state["representativeId"]


def restore(campus, state, backup):
    temporary = identity("recovery", secrets.token_hex(4))
    setup(campus, temporary)
    token = campus.login(temporary, "representative")
    campus.call("/api/admin/restore", {**backup, "currentPassword": temporary["password"]}, token)
    verify(campus, state)


def load(campus, state, workers):
    token = campus.login(state["student"], "student")
    routes = ["/api/requests", "/api/courses", "/api/files"]

    def timed_read(index):
        started = time.monotonic()
        campus.call(routes[index % len(routes)], token=token)
        return (time.monotonic() - started) * 1000

    with ThreadPoolExecutor(max_workers=workers) as executor:
        samples = sorted(executor.map(timed_read, range(60)))
    print(f"60 authenticated reads with {workers} workers. Errors: 0. "
          f"p50: {statistics.median(samples):.0f} ms; p95: {samples[56]:.0f} ms")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["seed", "verify", "load", "restore"])
    parser.add_argument("origin")
    parser.add_argument("state", type=Path)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--workers", type=int, choices=range(1, 7), default=4)
    parser.add_argument("--ci-loopback", action="store_true", help="Permit HTTP only for the isolated CI fixture")
    args = parser.parse_args()
    url = urlsplit(args.origin)
    if (not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/")
            or not (url.scheme == "https" or (args.ci_loopback and url.scheme == "http" and url.hostname == "127.0.0.1"))):
        parser.error("Supply an HTTPS origin without credentials or a path")
    if args.mode in ("seed", "restore") and not args.backup:
        parser.error("--backup is required for seed and restore")
    if args.mode == "seed" and (args.state.exists() or args.backup.exists()):
        parser.error("Choose new files for acceptance state and backup")
    campus = Campus(args.origin.rstrip("/"))
    campus.preflight()
    if args.mode == "seed":
        seed(campus, args.state, args.backup)
    else:
        state = json.loads(args.state.read_text())
        if args.mode == "verify":
            verify(campus, state)
        elif args.mode == "restore":
            restore(campus, state, json.loads(args.backup.read_text()))
        else:
            load(campus, state, args.workers)
    print("PASS: " + args.mode)


if __name__ == "__main__":
    main()
