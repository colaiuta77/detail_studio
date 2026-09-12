# 도서 상세 탭에 필요한 파일 정보와 권한별 유사 도서를 제공합니다.
import hashlib
import json
import re

from flask import has_request_context, request, session
from plugins.metadata.base import BaseMetadataProvider

PLUGIN_VERSION = '0.4.2'


def tokens(value):
    return {part.strip().casefold() for part in re.split(r'[,;|\n]', str(value or ''))
            if part.strip() and part.strip() != '-'}


class DetailStudioMetadataProvider(BaseMetadataProvider):
    id = 'detail_studio'
    name = 'Detail Studio · 도서 상세'
    version = PLUGIN_VERSION
    is_searchable = False
    config_schema = []
    detail_view = {'title': 'Detail Studio', 'sessions': ['general', 'adult', 'audiobook', 'video']}
    dashboard_widget = None
    category_tab = None

    def search(self, db_type, query):
        return []

    def apply(self, db_type, book_id, item_data):
        return False, '상세 화면의 메타정보 탭에서 수정해 주세요.'

    def get_dashboard_data(self, db_type, limit=12):
        # 공용 데이터 라우트에 login_required가 없으므로 여기서 반드시 검사한다.
        if not has_request_context() or not session.get('user_id'):
            return {'success': False, 'error': '로그인이 필요합니다.'}
        if session.get('is_default_password') == 1:
            return {'success': False, 'error': '비밀번호를 먼저 변경해 주세요.'}
        db_type = str(db_type or 'general').strip().lower()
        admin = session.get('role') == 'admin'
        if db_type not in ('general', 'adult', 'audiobook', 'video') or (
            db_type == 'adult' and not admin and session.get('has_adult_access') != 1
        ):
            return {'success': False, 'error': '접근할 수 없는 서재입니다.'}
        try:
            book_id = int(request.args.get('book_id', ''))
            limit = min(24, max(1, int(limit)))
        except (ValueError, TypeError):
            return {'success': False, 'error': '올바른 도서를 선택해 주세요.'}
        mode = request.args.get('mode', 'files')
        if book_id < 1 or mode not in ('files', 'similar'):
            return {'success': False, 'error': '올바르지 않은 요청입니다.'}

        gateway = self.get_db_gateway(db_type)
        libraries = [] if admin else sorted(str(row['library_id']) for row in gateway.fetch_all(
            'SELECT library_id FROM user_category_permissions WHERE user_id = ? AND has_access = 1',
            (session['user_id'],)))
        permission = '' if admin else ' AND b.library_id IN (' + ','.join('?' for _ in libraries) + ')'
        if not admin and not libraries:
            return {'success': False, 'error': '접근 가능한 서재가 없습니다.'}
        if db_type in ('audiobook', 'video'):
            return self._media_data(gateway, db_type, book_id, mode, limit, admin, permission, libraries)
        target = gateway.fetch_one(
            'SELECT b.id, b.series_name, b.library_id, b.author, b.genre, b.tags FROM books b '
            'WHERE b.id = ? AND COALESCE(b.is_deleted, 0) = 0' + permission,
            (book_id, *libraries))
        if not target:
            return {'success': False, 'error': '도서를 찾을 수 없거나 접근 권한이 없습니다.'}

        if mode == 'files':
            library = gateway.fetch_one('SELECT name FROM libraries WHERE id = ?', (target['library_id'],))
            files = gateway.fetch_all(
                'SELECT id, file_size, file_mtime, created_at FROM books WHERE series_name = ? '
                'AND library_id = ? AND COALESCE(is_deleted, 0) = 0 ORDER BY id',
                (target['series_name'], target['library_id']))
            # 기존 저장 API의 WHERE series_name 범위와 일치시킨다(삭제 표시 행도 포함).
            scope = gateway.fetch_one(
                'SELECT COUNT(*) AS books, COUNT(DISTINCT library_id) AS libraries FROM books WHERE series_name = ?',
                (target['series_name'],)) if admin else None
            return {'success': True, 'files': files, 'can_edit': admin, 'edit_scope': scope, 'library_name': library['name'] if library else '', 'library_id': target['library_id'], 'can_archive_download': db_type == 'general' or admin}

        signature = json.dumps([db_type, target, admin, libraries], sort_keys=True, ensure_ascii=False)
        cache_key = 'similar:' + hashlib.sha256(signature.encode()).hexdigest()
        try:
            cached = self.cache_get(cache_key)
            if cached:
                return {'success': True, 'items': json.loads(cached)[:limit]}
        except (ValueError, TypeError):
            pass

        groups = {field: tokens(target[field]) for field in ('author', 'genre', 'tags')}
        clauses, values = [], []
        for field, terms in groups.items():
            for term in sorted(terms)[:12]:
                clauses.append(f"LOWER(b.{field}) LIKE ? ESCAPE '!'")
                values.append('%' + term.replace('!', '!!').replace('%', '!%').replace('_', '!_') + '%')
        if not clauses:
            return {'success': True, 'items': []}
        # ponytail: 후보 400권의 규칙 기반 추천. 대형 서재에서 누락이 문제면 토큰 인덱스로 전환한다.
        rows = gateway.fetch_all(
            'SELECT b.id, b.series_name, b.library_id, b.author, b.genre, b.tags, b.cover_image, b.file_format '
            'FROM books b WHERE COALESCE(b.is_deleted, 0) = 0 '
            "AND b.series_name IS NOT NULL AND b.series_name <> '' AND b.series_name <> ?" + permission +
            ' AND (' + ' OR '.join(clauses) + ') ORDER BY b.id DESC LIMIT 400',
            (target['series_name'], *libraries, *values))
        ranked = {}
        for row in rows:
            reasons, score = [], 0
            for field, label, weight in [('author', '같은 작가', 6), ('genre', '공통 장르', 2), ('tags', '공통 태그', 1)]:
                common = groups[field] & tokens(row[field])
                if common:
                    reasons.append(label)
                    score += weight * len(common)
            if not score:
                continue
            key = (row['series_name'], row['library_id'])
            item = {'book_id': row['id'], 'series_name': row['series_name'], 'library_id': row['library_id'],
                    'author': row['author'], 'cover': row['cover_image'], 'file_format': row['file_format'],
                    'reasons': reasons, 'score': score}
            if key not in ranked or score > ranked[key]['score']:
                ranked[key] = item
        items = sorted(ranked.values(), key=lambda item: (-item['score'], item['series_name']))[:24]
        self.cache_set(cache_key, json.dumps(items, ensure_ascii=False), ttl=120)
        return {'success': True, 'items': items[:limit]}

    def _media_data(self, gateway, db_type, book_id, mode, limit, admin, permission, libraries):
        # 테이블과 필드는 검증된 세션에 대한 고정 매핑만 사용한다.
        audio = db_type == 'audiobook'
        table, field = ('audiobooks', 'author') if audio else ('videos', 'genres')
        target = gateway.fetch_one(
            f'SELECT b.id, b.title, b.library_id, b.{field} AS terms FROM {table} b '
            'WHERE b.id = ? AND COALESCE(b.is_deleted, 0) = 0' + permission,
            (book_id, *libraries))
        if not target:
            return {'success': False, 'error': '미디어를 찾을 수 없거나 접근 권한이 없습니다.'}
        if mode == 'files':
            library = gateway.fetch_one('SELECT name FROM libraries WHERE id = ?', (target['library_id'],))
            scope = gateway.fetch_one(
                'SELECT COUNT(*) AS books, COUNT(DISTINCT library_id) AS libraries FROM audiobooks '
                'WHERE title = ? OR folder_name = ?', (target['title'], target['title'])) if audio and admin else None
            # 크기와 경로는 코어 상세 컨텍스트의 트랙/에피소드 데이터를 사용한다.
            return {'success': True, 'files': [], 'can_edit': audio and admin, 'edit_scope': scope, 'library_name': library['name'] if library else '', 'library_id': target['library_id']}
        terms = tokens(target['terms'])
        if not terms:
            return {'success': True, 'items': []}
        values = ['%' + term.replace('!', '!!').replace('%', '!%').replace('_', '!_') + '%'
                  for term in sorted(terms)[:12]]
        clauses = ' OR '.join([f"LOWER(b.{field}) LIKE ? ESCAPE '!'" for _ in values])
        # ponytail: 후보 400개 한도. 대형 미디어 서재의 누락이 문제면 토큰 인덱스로 확장한다.
        rows = gateway.fetch_all(
            f'SELECT b.id, b.title, b.library_id, b.{field} AS terms FROM {table} b '
            'WHERE b.id <> ? AND COALESCE(b.is_deleted, 0) = 0' + permission +
            ' AND (' + clauses + ') ORDER BY b.id DESC LIMIT 400', (book_id, *libraries, *values))
        items = []
        for row in rows:
            common = terms & tokens(row['terms'])
            if common:
                items.append({'book_id': row['id'], 'series_name': row['title'], 'library_id': row['library_id'],
                              'author': row['terms'] if audio else '',
                              'cover': f"/api/media/{table}/{row['id']}/cover", 'file_format': '',
                              'reasons': ['같은 작가' if audio else '공통 장르'], 'score': len(common)})
        items.sort(key=lambda item: (-item['score'], item['series_name']))
        return {'success': True, 'items': items[:limit]}
