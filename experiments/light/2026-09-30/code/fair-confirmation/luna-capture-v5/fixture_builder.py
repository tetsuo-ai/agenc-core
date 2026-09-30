"""SYNTHETIC TEST ONLY: assembly recipe -> expectations AND request, never wire -> pins."""
import base64
import json
from pathlib import Path
import runpy
import sys

bridge = runpy.run_path(str(Path(__file__).resolve().with_name('binding_bridge.py')))
subject = bridge['load_binding']()


def build(recipe):
    if set(recipe) - {'profile', 'task', 'run_id', 'root_turn_id', 'protocol_id', 'effort', 'instructions'}:
        raise ValueError('unrecognized synthetic assembly setting')
    profile = recipe.get('profile', 'light-luna-base-v2')
    client, route, slots, instructions, sources = subject['PROFILES'][profile]
    task = recipe.get('task', 'Synthetic task only.')
    sha, canonical = subject['sha'], subject['canonical']
    body = {'model': 'gpt-6-luna' if route == 'openai-direct' else 'deepseek-flash', 'stream': True}
    if route == 'openai-direct':
        body.update(reasoning={'effort': recipe.get('effort', 'low'), 'summary': 'auto'}, max_output_tokens=8192)
    else:
        body.update(max_tokens=8192, thinking={'type': 'enabled'})
    messages, auxiliary = [], []
    for index, (name, role, form, message_type) in enumerate(slots):
        text = task if name == 'task' else 'Synthetic trusted ' + name + ' at ' + str(index)
        message = {'role': role, 'content': text if form == 'string' else [{'type': form, 'text': text}]}
        if message_type:
            message['type'] = message_type
        messages.append(message)
        if name != 'task':
            auxiliary.append({'index': index, 'slot': name,
                'origin': subject['ORIGINS'].get(name, client + '.static-system'), 'text_sha256': sha(text.encode())})
    body['input' if route == 'openai-direct' else 'messages'] = messages
    if instructions:
        body['instructions'] = recipe.get('instructions', 'Synthetic stable instructions.')
    contract = {'schema_version': 2, 'profile_id': profile,
        'protocol_id': recipe.get('protocol_id', 'synthetic-fair-v5'),
        'run_id': recipe.get('run_id', 'test'), 'root_turn_id': recipe.get('root_turn_id', 'root-1'),
        'task_index': next(i for i, slot in enumerate(slots) if slot[0] == 'task'),
        'task_prompt_sha256': sha(task.encode()), 'auxiliary': auxiliary,
        'instructions_sha256': sha(body['instructions'].encode()) if instructions else None,
        'source_inventory_sha256': sha(canonical(sources)),
        'client_artifact_sha256': 'b' * 64, 'configuration_sha256': 'c' * 64}
    envelope = {key: value for key, value in body.items() if key not in ('input', 'messages', 'instructions')}
    contract.update(envelope_fields=sorted(envelope), envelope_sha256=sha(canonical(envelope)))
    expected = {key: contract[key] for key in ('protocol_id', 'run_id', 'root_turn_id',
        'task_prompt_sha256', 'client_artifact_sha256', 'configuration_sha256')}
    contract_bytes = canonical(contract)
    expected.update(contract_sha256=sha(contract_bytes), client=client, route=route)
    return {'body': body, 'contract_base64': base64.b64encode(contract_bytes).decode(),
        'expected': expected, 'deployed_source_pins': sources}


if __name__ == '__main__':
    print(json.dumps(build(json.load(sys.stdin))))
