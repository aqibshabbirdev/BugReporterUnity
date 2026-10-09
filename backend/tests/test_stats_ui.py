"""Analytics scope and comparison regressions using an isolated SQL fixture."""
import contextlib
import json
import sqlite3
import time
import unittest
from unittest.mock import patch
from flask import Flask, g
from app import stats

class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript('''
          CREATE TABLE projects(id TEXT, name TEXT, team_id TEXT, created_at INTEGER);
          CREATE TABLE match_sessions(project_id TEXT, transaction_id TEXT, game_id INTEGER, created_at INTEGER);
          CREATE TABLE match_logs(project_id TEXT, transaction_id TEXT, game_id INTEGER, winner TEXT, event_count INTEGER, body TEXT, created_at INTEGER);
          CREATE TABLE match_flags(project_id TEXT, player_id TEXT, player_name TEXT, code TEXT, game TEXT, game_id INTEGER, transaction_id TEXT, detail TEXT, created_at INTEGER);
          INSERT INTO projects VALUES ('a','Project A','team',1),('b','Project B','team',2),('private','Private','other',3);
        ''')
        self.today = (int(time.time()) + stats.DAY_OFFSET) // 86400
        for pid, game, day, tx in [('a',2,0,'today'),('a',2,-1,'recent'),('a',2,-8,'previous'),('a',15,-1,'snooker'),('b',2,-1,'other'),('private',2,-1,'private')]:
            stamp = (self.today + day) * 86400 - stats.DAY_OFFSET + 100
            self.conn.execute('INSERT INTO match_sessions VALUES(?,?,?,?)',(pid,tx,game,stamp))
            self.conn.execute('INSERT INTO match_logs VALUES(?,?,?,?,?,?,?)',(pid,tx,game,'Demo',1,json.dumps({'players':[]}),stamp))
        self.app = Flask(__name__)
        @contextlib.contextmanager
        def connect(): yield self.conn
        self.dbpatch = patch.object(stats.db,'connect',connect); self.dbpatch.start()
    def tearDown(self): self.dbpatch.stop(); self.conn.close()
    def call(self, fn, url, *args):
        with self.app.test_request_context(url):
            g.user = {'team_id':'team'}
            return fn.__wrapped__(*args).get_json()
    def test_comparison_excludes_today_and_filters_game_and_project(self):
        data = self.call(stats.daily,'/api/stats/daily?days=7&project_id=a&game_id=2')
        self.assertEqual([p['project_id'] for p in data['projects']],['a'])
        self.assertEqual(data['projects'][0]['comparison'],{'days':7,'completed':1,'previous':1})
        self.assertEqual(sum(d['total'] for d in data['projects'][0]['days']),2)
        self.assertFalse(data['sample_data'])
    def test_match_scope_cannot_cross_team(self):
        date = time.strftime('%Y-%m-%d',time.gmtime((self.today-1)*86400))
        data = self.call(stats.matches_of_day,'/api/stats/matches?date='+date+'&project_id=a&game_id=2')
        self.assertEqual([m['transaction_id'] for m in data['matches']],['recent'])
        self.assertEqual(self.call(stats.daily,'/api/stats/daily?project_id=private')['projects'],[])
    def test_invalid_game_returns_no_matches(self):
        data = self.call(stats.daily,'/api/stats/daily?game_id=invalid')
        self.assertTrue(all(not any(d['total'] for d in p['days']) for p in data['projects']))
    def test_flags_respect_selected_period(self):
        for days in [1,40]:
            self.conn.execute('INSERT INTO match_flags VALUES(?,?,?,?,?,?,?,?,?)',('a','player','Demo','roll_twice','Ludo',2,'tx','Example',(self.today-days)*86400-stats.DAY_OFFSET+100))
        data = self.call(stats.player_flags,'/api/stats/flags/player?days=7&project_id=a&game_id=2','player')
        self.assertEqual(len(data['flags']),1)
    def test_sample_banner_requires_explicit_metadata(self):
        with patch.dict('os.environ',{'BR_STATS_SAMPLE_DATA':'true'}):
            self.assertTrue(self.call(stats.daily,'/api/stats/daily')['sample_data'])
if __name__ == '__main__': unittest.main()
