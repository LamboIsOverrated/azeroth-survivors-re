"""Initialize private runtime data. Nothing from the archive enters an image or Git."""
import os
import re
import shutil
import subprocess
import zipfile
import json
from pathlib import Path


def selected_entries(archive):
    entries = [item for item in archive.infolist() if item.filename.startswith('Data/') and item.filename.lower().endswith('.mpq')]
    if not entries or any(not re.fullmatch(r'Data/[A-Za-z0-9 _-]+\.[Mm][Pp][Qq]', item.filename) for item in entries):
        raise ValueError('Unexpected game archive paths')
    names = {item.filename.lower() for item in entries}
    if not {'data/terrain.mpq', 'data/patch.mpq'}.issubset(names):
        raise ValueError('Required game archives are missing')
    if len(names) != len(entries) or sum(item.file_size for item in entries) > 16 * 1024**3:
        raise ValueError('Unexpected archive entries or size')
    return entries


def prepare():
    target = Path(os.environ.get('CLIENT_DATA', '/state/client/Data')).resolve()
    target.mkdir(parents=True, exist_ok=True)
    archive_path = target.parent / 'client-input.zip'
    source = os.environ.get('WOW_DATA_URL', 'https://archive.org/download/WoW_1.12.1-5875/1.12.1-5875_enUS.zip')
    if not source.startswith('https://'):
        raise ValueError('Game data source must use HTTPS')
    complete = archive_path.is_file() and zipfile.is_zipfile(archive_path)
    if not complete:
        subprocess.run(['curl', '--fail', '--location', '--retry', '4', '--retry-delay', '3', '--continue-at', '-', '--output', str(archive_path), source], check=True)
    with zipfile.ZipFile(archive_path) as archive:
        entries = selected_entries(archive)
        for entry in entries:
            final = target / entry.filename.split('/')[1]
            temporary = final.with_name(final.name + '.partial')
            # ZIP streaming verifies CRC before the output becomes an active MPQ.
            with archive.open(entry) as input_file, temporary.open('wb') as output_file:
                shutil.copyfileobj(input_file, output_file, length=1024**2)
                output_file.flush()
                os.fsync(output_file.fileno())
            temporary.replace(final)
        # Publish completion only after every selected archive passed streaming CRC checks.
        manifest = {'files': [{'name': item.filename.split('/')[1], 'size': item.file_size, 'crc': item.CRC} for item in entries]}
        marker = target / '.client-data.json.partial'
        with marker.open('w') as marker_file:
            marker_file.write(json.dumps(manifest))
            marker_file.flush()
            os.fsync(marker_file.fileno())
        marker.replace(target / '.client-data.json')
    archive_path.unlink()
    print('Private client data initialized.', flush=True)


if __name__ == '__main__':
    try:
        prepare()
    except Exception as error:
        # Do not put a configured source URL (which may be signed) into logs.
        print(f'Private client data preparation failed: {type(error).__name__}', flush=True)
        raise SystemExit(1)
