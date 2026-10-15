import ast
import json
import sys


def inspect_source(data):
    tree = ast.parse(data['text'])
    definitions = []
    imports = []

    def visit(node, scope=''):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                name = scope + child.name
                start = min([child.lineno] + [d.lineno for d in child.decorator_list])
                definitions.append({'name': name, 'start': start, 'end': child.end_lineno,
                                    'node': child, 'kind': type(child).__name__})
                visit(child, name + '.')
            else:
                visit(child, scope)

    visit(tree)
    if len(definitions) > 2000:
        raise ValueError('Definition index exceeds structural budget')
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            imports.append({'start': node.lineno, 'end': node.end_lineno})
    selected = []
    unresolved = []
    for selector in data['selectors']:
        matches = [d for d in definitions if d['name'] == selector or
                   ('.' not in selector and d['name'].split('.')[-1] == selector)]
        if len(matches) != 1:
            unresolved.append({'selector': selector, 'matches': len(matches)})
        elif matches[0] not in selected:
            selected.append(matches[0])
    dependencies = []
    if not unresolved and data.get('follow_calls', False):
        for record in selected:
            scope = record['name'].rsplit('.', 1)[0] if '.' in record['name'] else ''
            for call in ast.walk(record['node']):
                if not isinstance(call, ast.Call):
                    continue
                target = None
                if isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name) and call.func.value.id == 'self' and scope:
                    target = scope + '.' + call.func.attr
                elif isinstance(call.func, ast.Name):
                    target = call.func.id
                matches = [d for d in definitions if d['name'] == target]
                if len(matches) == 1 and matches[0] not in selected and matches[0] not in dependencies:
                    dependencies.append(matches[0])
    public = lambda d: {k: v for k, v in d.items() if k != 'node'}
    return {'definitions': [public(d) for d in definitions],
            'selected': [public(d) for d in selected], 'unresolved': unresolved,
            'dependencies': [public(d) for d in dependencies], 'imports': imports}


if __name__ == '__main__':
    try:
        print(json.dumps(inspect_source(json.load(sys.stdin)), separators=(',', ':')))
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        print(json.dumps({'boundary': 'Source syntax cannot be indexed under the declared structural budget; use exact raw recovery.'}))
