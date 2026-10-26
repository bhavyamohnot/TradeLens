# Splices the one-pager and the other artifact pages into submission.html.
import pathlib
here = pathlib.Path(__file__).parent
one = (here / 'one-pager.html').read_text(encoding='utf-8')
sections = (here / 'sections.html').read_text(encoding='utf-8')
sections = sections.replace('<!--PROMPTS-->', (here / 'prompts-trail.html').read_text(encoding='utf-8'))
one = one.replace('<title>TradeLens — one-pager</title>', '<title>TradeLens — submission</title>')
one = one.replace('<span>Companion artifacts: prompts · evals · working app</span>',
                  '<span>Live app: trade-lens-omega.vercel.app · Prompts p.2–3 · Evals p.4 · App p.5</span>')
one = one.replace('</body>', sections + '\n</body>')
(here / 'submission.html').write_text(one, encoding='utf-8')
print('ok')
