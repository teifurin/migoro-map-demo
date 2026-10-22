.PHONY: test test-py test-js

# 標準ライブラリだけで動く回帰テスト（実際の Gemini / Nominatim には接続しない）
JS_TESTS = tests/frontend.test.js tests/page.test.js

test: test-py test-js

test-py:
	python3 -m unittest discover -s tests -v

# Node 18〜24 で同じ挙動になるよう、ディレクトリ探索ではなくファイルを明示する
test-js:
	node --test $(JS_TESTS)
