"""Construction schedules: reading MS Project XML, Primavera XER, CSV and Excel, and matching
tasks to parts of the model. Sample files follow each program's documented export layout."""

from __future__ import annotations

import io
from datetime import date

import pytest
from openpyxl import Workbook

from app.animation import Script
from app.schedule import ScheduleUnreadable, level_of, match_all, read_schedule, storey_levels

from .test_studio import new_project

STOREYS = ["Ground floor", "First floor"]


def msp_xml() -> bytes:
    def task(uid, name, start, finish, level, summary=0, milestone=0):
        return (f"<Task><UID>{uid}</UID><Name>{name}</Name><OutlineLevel>{level}</OutlineLevel><Summary>{summary}</Summary>"
                f"<Milestone>{milestone}</Milestone><Start>{start}T08:00:00</Start><Finish>{finish}T17:00:00</Finish></Task>")
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Project xmlns="http://schemas.microsoft.com/project"><Name>Villa</Name><Tasks>'
            + task(1, "Villa construction", "2027-01-04", "2027-06-30", 1, summary=1)
            + task(2, "Site clearance and setting out", "2027-01-04", "2027-01-15", 2)
            + task(3, "Strip footings", "2027-01-18", "2027-02-05", 2)
            + task(4, "Ground floor", "2027-02-08", "2027-03-19", 2, summary=1)
            + task(5, "Columns", "2027-02-08", "2027-02-19", 3)
            + task(6, "Blockwork", "2027-03-01", "2027-03-19", 3)
            + task(7, "First floor slab", "2027-02-22", "2027-03-05", 2)
            + task(8, "Roof structure and covering", "2027-04-05", "2027-05-07", 2)
            + task(9, "Windows and doors", "2027-05-10", "2027-05-28", 2)
            + task(10, "Practical completion", "2027-06-30", "2027-06-30", 2, milestone=1)
            + "</Tasks></Project>").encode()


def xer() -> bytes:
    rows = ["ERMHDR\t19.12\t2027-01-01\tProject\tadmin",
            "%T\tPROJWBS", "%F\twbs_id\tproj_node_flag\twbs_name\tparent_wbs_id",
            "%R\t1\tY\tVilla\t", "%R\t2\tN\tLevel 1\t1", "%R\t3\tN\tSubstructure\t1",
            "%T\tTASK", "%F\ttask_id\twbs_id\ttask_code\ttask_name\ttask_type\ttarget_start_date\ttarget_end_date\tact_start_date\tact_end_date",
            "%R\t10\t3\tA100\tPile caps\tTT_Task\t2027-01-11 08:00\t2027-01-29 17:00\t2027-01-12 08:00\t",
            "%R\t11\t2\tA200\tSuspended slab\tTT_Task\t2027-02-01 08:00\t2027-02-19 17:00\t\t",
            "%R\t12\t2\tA210\tPartitions\tTT_Task\t2027-02-22 08:00\t2027-03-12 17:00\t\t",
            "%E"]
    return "\r\n".join(rows).encode()


def csv_bytes() -> bytes:
    return ("Villa programme\n\nTask Name,Start,Finish,WBS\n"
            "Excavation,Mon 04/01/27,Fri 15/01/27,Site\n"
            "Raft foundation,18/01/2027,05/02/2027,Substructure\n"
            "L1 columns,08/02/2027,19/02/2027,Superstructure\n"
            "Plumbing and electrical,01/03/2027,31/03/2027,Services\n"
            "Painting,01/04/2027,30/04/2027,Finishes\n").encode()


def xlsx_bytes() -> bytes:
    wb = Workbook(); ws = wb.active
    ws.append(["Activity", "Planned Start", "Planned Finish"])
    ws.append(["Ground floor walls", date(2027, 3, 1), date(2027, 3, 20)])
    ws.append(["Roof slab", date(2027, 4, 1), date(2027, 4, 20)])
    ws.append(["", None, None])
    buf = io.BytesIO(); wb.save(buf); return buf.getvalue()


def test_ms_project_xml():
    fmt, tasks = read_schedule(msp_xml(), "villa.xml")
    assert fmt == "Microsoft Project"
    assert [t.name for t in tasks][:2] == ["Site clearance and setting out", "Strip footings"]     # summaries left out
    assert "Ground floor" not in [t.name for t in tasks] and len(tasks) == 8
    m = {t.name: t for t in match_all(tasks, STOREYS)}
    assert (m["Site clearance and setting out"].group, m["Strip footings"].group) == ("site", "foundation")
    assert (m["Columns"].group, m["Columns"].kind, m["Columns"].floors) == ("structure", "columns", ["Ground floor"])   # floor from its summary
    assert m["Blockwork"].group == "walls" and m["Blockwork"].floors == ["Ground floor"]
    assert (m["First floor slab"].kind, m["First floor slab"].floors) == ("slabs", ["First floor"])
    assert m["Roof structure and covering"].group == "roof" and m["Windows and doors"].group == "openings"
    assert m["Practical completion"].milestone and m["Practical completion"].group == "none"
    assert m["Columns"].start == date(2027, 2, 8) and m["Columns"].finish == date(2027, 2, 19)


def test_primavera_xer():
    fmt, tasks = read_schedule(xer(), "villa.xer")
    assert fmt == "Primavera P6"
    m = {t.name: t for t in match_all(tasks, ["Level 0", "Level 1", "Level 2"])}
    assert m["Pile caps"].group == "foundation" and m["Pile caps"].start == date(2027, 1, 12)        # actual start wins
    assert m["Suspended slab"].floors == ["Level 1"] and m["Suspended slab"].context == "Level 1"    # floor from the WBS
    assert m["Partitions"].group == "walls"


def test_csv_with_a_title_row_and_day_first_dates():
    fmt, tasks = read_schedule(csv_bytes(), "programme.csv")
    assert fmt == "CSV" and len(tasks) == 5
    m = {t.name: t for t in match_all(tasks, ["Level 0", "Level 1"])}
    assert m["Excavation"].start == date(2027, 1, 4) and m["Raft foundation"].finish == date(2027, 2, 5)
    assert m["L1 columns"].floors == ["Level 1"] and m["Plumbing and electrical"].group == "mep" and m["Painting"].group == "finishes"


def test_excel():
    fmt, tasks = read_schedule(xlsx_bytes(), "p.xlsx")
    m = {t.name: t for t in match_all(tasks, STOREYS)}
    assert fmt == "Excel" and m["Ground floor walls"].floors == ["Ground floor"] and m["Roof slab"].group == "roof"


def test_unreadable_files_get_a_reason():
    with pytest.raises(ScheduleUnreadable, match="Save As > XML"):
        read_schedule(b"\xd0\xcf\x11\xe0" + b"\0" * 100, "villa.mpp")
    with pytest.raises(ScheduleUnreadable, match="headings"):
        read_schedule(b"a,b,c\n1,2,3\n", "x.csv")
    with pytest.raises(ScheduleUnreadable, match="empty"):
        read_schedule(b"", "x.csv")


def test_floor_words():
    assert level_of("Level 3 slab") == [3] and level_of("2nd floor walls") == [2] and level_of("GF blockwork") == [0]
    assert level_of("First floor columns") == [1] and level_of("Basement walls") == [-1] and level_of("Levels 2-4 facade") == [2, 3, 4]
    assert storey_levels(["Ground floor", "First floor", "Roof"]) == {"Ground floor": 0, "First floor": 1, "Roof": 2}
    assert storey_levels(["A", "B"]) == {"A": 0, "B": 1}


def test_programme_travels_in_the_animation_settings():
    s = Script.model_validate({"schedule": [{"name": "Columns", "start": "2027-02-08", "finish": "2027-02-19", "group": "structure", "kind": "columns",
                                            "floors": ["Ground floor"]}], "schedule_seconds": 500})
    assert s.schedule_seconds == 180 and s.schedule[0].kind == "columns"
    assert Script.model_validate(s.model_dump(mode="json")) == s


def test_read_schedule_endpoint(client, alice, bob):
    pid = new_project(client, alice)
    r = client.post(f"/api/projects/{pid}/schedule/read", files={"file": ("villa.xml", msp_xml(), "text/xml")},
                    data={"storeys": '["Ground floor", "First floor"]'}, headers=alice["headers"])
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["format"] == "Microsoft Project" and out["start"] == "2027-01-04" and out["matched"] == 7 and len(out["tasks"]) == 8
    assert any(g["id"] == "mep" for g in out["groups"])
    bad = client.post(f"/api/projects/{pid}/schedule/read", files={"file": ("v.mpp", b"\xd0\xcf\x11\xe0xxxx", "application/octet-stream")}, headers=alice["headers"])
    assert bad.status_code == 422 and "XML" in bad.json()["detail"]["reason"]
    assert client.post(f"/api/projects/{pid}/schedule/read", files={"file": ("villa.xml", msp_xml(), "text/xml")}, headers=bob["headers"]).status_code == 404
