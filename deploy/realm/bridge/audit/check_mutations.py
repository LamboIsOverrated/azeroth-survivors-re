#!/usr/bin/env python3
"""Offline, fail-closed comparison with the reviewed exact CMaNGOS source.

This is a source-coverage/review gate, not a C++ verifier or an economic
authorization mechanism. It performs no fetches and writes no source files.
"""
import argparse
import collections
import hashlib
import json
import os
import pathlib
import re
import sys

REVISION = "de8f72993b9e1faa1bf92dd5505f3daec5cea3ce"
REPOSITORY = "https://github.com/cmangos/mangos-classic"
DEFAULT_MANIFEST = pathlib.Path(__file__).with_name("expected-sites.json")
DEFAULT_EVENT_MAP = pathlib.Path(__file__).with_name("event-map.json")
CPP_SUFFIXES = {".cpp", ".h", ".hpp", ".c", ".cc", ".hxx", ".inl", ".ipp"}


def safe_path(value):
    return (isinstance(value, str) and value != "" and "\\" not in value
            and not pathlib.PurePosixPath(value).is_absolute()
            and all(part not in {"", ".", ".."} for part in value.split("/"))
            and ":" not in value)


def uncomment(text):
    """Preserve newlines, strings and offsets while removing C/C++ comments."""
    pattern = r'("(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\')|//[^\n]*|/\*[\s\S]*?\*/'
    return re.sub(pattern, lambda m: m.group(1) if m.group(1) else
                  re.sub(r"[^\n]", " ", m.group(0)), text)


def discover_sites(path, raw):
    if pathlib.PurePosixPath(path).suffix.lower() not in CPP_SUFFIXES:
        return []
    text = uncomment(raw.decode("utf-8", errors="replace"))
    # These are deliberately review surfaces, including declarations/helpers.
    # Complete file coverage catches alternate spellings and scanner blind spots.
    patterns = [
        ("money-api", re.compile(r"\b(ModifyMoney|SetMoney)\s*\(")),
        ("coinage-field", re.compile(r"\b(PLAYER_FIELD_COINAGE)\b")),
        ("escrow-assignment", re.compile(r"\b(money|COD|cod|bid|deposit|m_money|m_COD|m_gold)\s*(?:\+=|-=|=(?!=))")),
        ("money-sql", re.compile(r"\b((?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+`?(?:characters|mail|auction)`?)\b", re.I)),
        ("generic-field-write", re.compile(r"\b((?:Set|ApplyMod|Remove|Toggle)[A-Za-z0-9_]*)\s*\(\s*(?:field|index|pField->offset|m_script->(?:setField|setFlag|removeFlag)\.fieldId)\b")),
        ("raw-value-write", re.compile(r"\b(m_(?:u?int32|float)Values)\s*\[[^\n]+?\]\s*(?:[+\-*/|&^]?=(?!=))")),
    ]
    found = []
    ordinals = collections.Counter()
    for kind, pattern in patterns:
        for match in pattern.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            symbol = re.sub(r"\s+", " ", match.group(1))
            ordinals[(line, kind, symbol)] += 1
            found.append({"path": path, "line": line, "kind": kind,
                          "symbol": symbol, "ordinal": ordinals[(line, kind, symbol)]})
    return sorted(found, key=site_key)


def site_key(site):
    return (site["path"], site["line"], site["kind"], site["symbol"], site["ordinal"])


def site_label(site):
    return ":".join(str(v) for v in site_key(site))


def validate_manifest(manifest):
    errors = []
    if manifest.get("schema") != 1:
        errors.append("unsupported-schema")
    if manifest.get("revision") != REVISION:
        errors.append("unsupported-revision")
    if manifest.get("repository") != REPOSITORY:
        errors.append("unsupported-repository")
    coverage, files, sites = manifest.get("coverage"), manifest.get("files"), manifest.get("sites")
    if (not isinstance(coverage, list) or not coverage or not all(safe_path(p) for p in coverage)
            or not isinstance(files, dict) or not files
            or not all(safe_path(p) for p in files)):
        errors.append("unsafe-manifest-path")
        return errors
    if any(not isinstance(h, str) or not re.fullmatch(r"[a-f0-9]{64}", h) for h in files.values()):
        errors.append("invalid-source-hash")
    if any(not any(p == c or p.startswith(c + "/") for c in coverage) for p in files):
        errors.append("manifest-file-outside-coverage")
    if not isinstance(sites, list):
        errors.append("invalid-sites")
        return errors
    seen = set()
    for site in sites:
        if (not isinstance(site, dict) or set(site) != {"path", "line", "kind", "symbol", "ordinal"}
                or site.get("path") not in files or type(site.get("line")) is not int
                or site["line"] < 1 or type(site.get("ordinal")) is not int or site["ordinal"] < 1
                or not isinstance(site.get("kind"), str) or not isinstance(site.get("symbol"), str)):
            errors.append("invalid-site")
            continue
        key = site_key(site)
        if key in seen:
            errors.append("duplicate-site")
        seen.add(key)
    return errors


def covered_files(source, coverage):
    found, errors = {}, []
    for relative in coverage:
        base = source / relative
        if base.is_symlink():
            errors.append("symlink-file:" + relative)
        elif base.is_file():
            found[relative] = base
        elif base.is_dir():
            for directory, dirs, names in os.walk(base, followlinks=False):
                for name in list(dirs):
                    child = pathlib.Path(directory) / name
                    if child.is_symlink():
                        errors.append("symlink-file:" + child.relative_to(source).as_posix())
                        dirs.remove(name)
                for name in names:
                    child = pathlib.Path(directory) / name
                    rel = child.relative_to(source).as_posix()
                    if child.is_symlink():
                        errors.append("symlink-file:" + rel)
                    else:
                        found[rel] = child
        else:
            errors.append("missing-coverage:" + relative)
    return found, errors


def check_event_map(manifest, events):
    if (not isinstance(events, dict) or events.get("schema") != 1
            or events.get("revision") != REVISION
            or not isinstance(events.get("event_sites"), list)
            or not isinstance(events.get("helper_sites"), list)):
        return ["invalid-event-map"], 0
    api = {(s["path"], s["line"], s["symbol"]) for s in manifest["sites"] if s["kind"] == "money-api"}
    coinage = {(s["path"], s["line"], "SetUInt32Value") for s in manifest["sites"] if s["kind"] == "coinage-field"}
    # At this supported pin Player.cpp has exactly one coinage-field occurrence:
    # direct character creation, which bypasses both money APIs. A missing
    # policy for that sink must fail just as a missing ModifyMoney policy does.
    direct_events = {key for key in coinage if key[0] == "src/game/Entities/Player.cpp"}
    seen, errors = set(), []
    for group in ("event_sites", "helper_sites"):
        for entry in events[group]:
            if (not isinstance(entry, dict) or not safe_path(entry.get("path"))
                    or type(entry.get("line")) is not int or entry["line"] < 1
                    or not isinstance(entry.get("symbol"), str)):
                errors.append("invalid-event-site")
                continue
            required = ("family", "required_policy") if group == "event_sites" else ("role",)
            if any(not isinstance(entry.get(k), str) or not entry[k] for k in required):
                errors.append("invalid-event-policy")
            key = (entry["path"], entry["line"], entry["symbol"])
            if key not in api and not (group == "event_sites" and key in coinage):
                errors.append("unknown-event-site:" + ":".join(map(str, key)))
            if key in seen:
                errors.append("duplicate-event-site:" + ":".join(map(str, key)))
            seen.add(key)
    errors += ["unclassified-money-api:" + ":".join(map(str, key)) for key in api - seen]
    errors += ["unclassified-direct-money-write:" + ":".join(map(str, key)) for key in direct_events - seen]
    return errors, len(api & seen)


def audit(source, manifest, events=None):
    errors = validate_manifest(manifest)
    if errors:
        return 2, {"status": "invalid-manifest", "errors": sorted(set(errors))}
    source = pathlib.Path(source).resolve()
    files, errors = covered_files(source, manifest["coverage"])
    expected = manifest["files"]
    errors += ["unreviewed-file:" + p for p in files.keys() - expected.keys()]
    errors += ["missing-file:" + p for p in expected.keys() - files.keys()]
    sites = []
    for path, local in sorted(files.items()):
        try:
            raw = local.read_bytes()
        except OSError:
            errors.append("unreadable-file:" + path)
            continue
        if path in expected and hashlib.sha256(raw).hexdigest() != expected[path]:
            errors.append("changed-file:" + path)
        sites.extend(discover_sites(path, raw))
    actual_sites = {site_key(s) for s in sites}
    expected_sites = {site_key(s) for s in manifest["sites"]}
    errors += ["unreviewed-site:" + ":".join(map(str, key)) for key in actual_sites - expected_sites]
    errors += ["missing-site:" + ":".join(map(str, key)) for key in expected_sites - actual_sites]
    classified = None
    if events is not None:
        policy_errors, classified = check_event_map(manifest, events)
        errors += policy_errors
    report = {"status": "reviewed-source-match" if not errors else "review-required",
              "revision": REVISION, "file_count": len(files), "site_count": len(sites),
              "counts_by_kind": dict(sorted(collections.Counter(s["kind"] for s in sites).items())),
              "errors": sorted(set(errors)),
              "limits": "Source review coverage only; no runtime hooks, backing, or financial authorization."}
    if classified is not None:
        report["classified_money_api_count"] = classified
    return (1 if errors else 0), report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=pathlib.Path)
    parser.add_argument("--manifest", type=pathlib.Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--event-map", type=pathlib.Path,
                        help="Explicit reviewed event map; default inventory uses its shipped event map.")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise ValueError("manifest must be an object")
        event_path = args.event_map
        if event_path is None and args.manifest.resolve() == DEFAULT_MANIFEST.resolve():
            event_path = DEFAULT_EVENT_MAP
        events = json.loads(event_path.read_text(encoding="utf-8")) if event_path else None
        code, report = audit(args.source, manifest, events)
    except (OSError, ValueError) as error:
        code, report = 2, {"status": "invalid-input", "errors": [str(error)]}
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(report["status"])
        for error in report["errors"]:
            print(error)
        if code == 0:
            print(f"{report['file_count']} files; {report['site_count']} reviewed sites; {REVISION}")
        print("This audit does not establish reserve backing or authorize LIVE currency.")
    return code


if __name__ == "__main__":
    sys.exit(main())
