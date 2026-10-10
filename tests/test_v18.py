import json
import pytest
from backend.audit_chain import append_record, create_anchor, verify_anchor

KEY=b'x'*32

def test_anchor_roundtrip_and_append(tmp_path):
    log=tmp_path/'audit.jsonl'; anchor=tmp_path/'anchor.json'
    append_record(log,{'actor':'a'})
    create_anchor(log,anchor,KEY)
    append_record(log,{'actor':'b'})
    result=verify_anchor(log,anchor,KEY)
    assert result['anchored_records']==1 and result['current_records']==2

def test_anchor_detects_truncation(tmp_path):
    log=tmp_path/'audit.jsonl'; anchor=tmp_path/'anchor.json'
    append_record(log,{'actor':'a'}); append_record(log,{'actor':'b'})
    create_anchor(log,anchor,KEY)
    log.write_text(log.read_text().splitlines()[0]+'\n')
    with pytest.raises(ValueError,match='truncated'):
        verify_anchor(log,anchor,KEY)

def test_anchor_detects_rewritten_valid_chain(tmp_path):
    log=tmp_path/'audit.jsonl'; anchor=tmp_path/'anchor.json'
    append_record(log,{'actor':'a'}); create_anchor(log,anchor,KEY)
    log.unlink(); append_record(log,{'actor':'intruder'})
    with pytest.raises(ValueError,match='prefix mismatch'):
        verify_anchor(log,anchor,KEY)

def test_anchor_signature_modified(tmp_path):
    log=tmp_path/'audit.jsonl'; anchor=tmp_path/'anchor.json'
    append_record(log,{'actor':'a'}); create_anchor(log,anchor,KEY)
    data=json.loads(anchor.read_text()); data['checkpoint']['records']=0
    anchor.write_text(json.dumps(data))
    with pytest.raises(ValueError,match='signature mismatch'):
        verify_anchor(log,anchor,KEY)

def test_anchor_refuses_bad_key(tmp_path):
    log=tmp_path/'audit.jsonl'; append_record(log,{'actor':'a'})
    with pytest.raises(ValueError,match='at least 32'):
        create_anchor(log,tmp_path/'anchor.json',b'short')
