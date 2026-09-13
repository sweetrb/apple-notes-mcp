#!/usr/bin/env python3
"""Build the reviewed fixed-operation, background-only Notes bridge."""
import importlib.util
import plistlib
from pathlib import Path
from uuid import uuid5, NAMESPACE_URL
spec = importlib.util.spec_from_file_location('tags', Path(__file__).with_name('build-native-tags-shortcut.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
action, native, output, token, text_token, uid = b.action, b.native, b.output, b.token, b.text_token, b.uid
NAME = 'Apple Notes MCP - Background Operations v5'

def uid(label):
    return str(uuid5(NAMESPACE_URL, 'apple-notes-mcp/background/v5/' + label)).upper()

b.uid = uid

def native(identifier, label, **params):
    if identifier in ['CreateChecklistItemLinkAction', 'CreateTagLinkAction']:
        params['OpenWhenRun'] = False
    return b.native(identifier, label, **params)

def append(label, source):
    # Native editor serialization on macOS 26: legacy parameter keys remain,
    # but WFInput must be a text-token string, not a bare action-output token.
    # A bare token prompted for text; modern text/entity keys prompted for both.
    return action('is.workflow.actions.appendnote',label,
                  WFInput=text_token(output(source)),WFNote=output('target'),
                  AppIntentDescriptor={'AppIntentIdentifier':'AppendToNoteLinkAction',
                                       'BundleIdentifier':'com.apple.Notes',
                                       'TeamIdentifier':'0000000000','Name':'Notes'})

def condition(label, source, value, mode=4):
    return action('is.workflow.actions.conditional', label, GroupingIdentifier=uid(label+'-group'), WFControlFlowMode=0,
                  WFInput={'Type':'Variable','Variable':source}, WFCondition=mode, WFConditionalActionString=value)

def end(label):
    return action('is.workflow.actions.conditional', label+'-end', GroupingIdentifier=uid(label+'-group'), WFControlFlowMode=2)

def getprop(label, obj, prop):
    v=dict(obj['Value']);v['Aggrandizements']=[{'Type':'WFPropertyVariableAggrandizement','PropertyName':prop}]
    return action('is.workflow.actions.gettext',label,WFTextActionText=text_token(token(v)))

def select(label,title,scope):
    # Both native search AND literal comparisons are required. Native search is tokenized.
    return [action('is.workflow.actions.filter.notes',label,WFContentItemLimitEnabled=False,
       WFContentItemFilter={'WFSerializationType':'WFContentPredicateTableTemplate','Value':{
       'WFActionParameterFilterPrefix':1,'WFContentPredicateBoundedDate':False,
       'WFActionParameterFilterTemplates':[{'Property':p,'Operator':99,'Removable':True,'Values':{'String':text_token(output(k))}} for p,k in [('Name',title),('Body',scope)]]}}),
       action('is.workflow.actions.count',label+'-count',Input=output(label),WFCountType='Items'),
       action('is.workflow.actions.gettext',label+'-count-text',WFTextActionText=text_token(output(label+'-count'))),
       condition(label+'-one',output(label+'-count-text'),'1'),
       getprop(label+'-name',output(label),'Name'),condition(label+'-exact-name',output(label+'-name'),text_token(output(title))),
       getprop(label+'-body',output(label),'Body'),condition(label+'-exact-body',output(label+'-body'),text_token(output(scope)),99)]

def close_select(label):
    return [end(label+'-exact-body'),end(label+'-exact-name'),end(label+'-one')]

def build():
    a=[action('is.workflow.actions.comment','background-about',WFCommentActionText='Background Notes MCP bridge v5. Native-editor typed append input; native create actions have OpenWhenRun disabled; pin operations use fixed enum values. Exact title and literal body scope checked after unique search. MCP validates IDs, revisions and readback. No UI actions, database writes, shell scripts, network or arbitrary action execution.'),
       action('is.workflow.actions.detect.dictionary','request',WFInput=token({'Type':'ExtensionInput'}))]
    for k in ['operation','title','scopeText','text','objectId','objectName','change','otherTitle','otherScope','tag','size']:
        a.append(action('is.workflow.actions.getvalueforkey',k+'-value',WFInput=output('request'),WFDictionaryKey=k,WFGetDictionaryValueType='Value'))
        # Dictionary Value is an untyped Content Item. Conditional Action cannot
        # validate a string comparison against that input type at runtime.
        a.append(action('is.workflow.actions.gettext',k,WFTextActionText=text_token(output(k+'-value'))))
    a += select('target','title','scopeText')
    ops = {
      'probe':[action('is.workflow.actions.gettext','probe-ready',WFTextActionText='APPLE_NOTES_BACKGROUND_V5_READY')],
      'append-text':[append('append-text-result','text')],
      'append-markdown':[action('is.workflow.actions.getrichtextfrommarkdown','markdown-rich',WFInput=output('text')),append('append-md-result','markdown-rich')],
      'create-checklist-item':[native('CreateChecklistItemLinkAction','checklist-created',noteEntity=output('target'),name=text_token(output('text')))],
      'append-html':[action('is.workflow.actions.getrichtextfromhtml','html-rich',WFHTML=output('text')),append('append-html-result','html-rich')],
      'set-pinned':[condition('pin-add',output('change'),'add'),native('PinNotesLinkAction','pinned',entities=output('target'),operation='add'),end('pin-add'),
                    condition('pin-remove',output('change'),'remove'),native('PinNotesLinkAction','unpinned',entities=output('target'),operation='remove'),end('pin-remove')],
      'add-tag':[native('CreateTagLinkAction','tag-resolved',name=text_token(output('tag'))),native('AddTagsToNotesLinkAction','tag-added',notes=output('target'),tags=output('tag-resolved'))],
      'remove-tag':[native('CreateTagLinkAction','remove-tag-resolved',name=text_token(output('tag'))),native('RemoveTagsFromNotesLinkAction','tag-removed',notes=output('target'),tags=output('remove-tag-resolved'))],
    }
    for op, steps in ops.items():
        label='op-'+op
        a.append(condition(label,output('operation'),op)); a += steps
        a.append(action('is.workflow.actions.gettext',label+'-ok',WFTextActionText='APPLE_NOTES_BACKGROUND_V5_READY' if op == 'probe' else 'APPLE_NOTES_BACKGROUND_V5_DONE'))
        a.append(action('is.workflow.actions.output',label+'-output',WFOutput=text_token(output(label+'-ok'))))
        a.append(end(label))
    a += close_select('target')
    a += [action('is.workflow.actions.gettext','refused',WFTextActionText='APPLE_NOTES_BACKGROUND_V5_REFUSED'),action('is.workflow.actions.output','refused-output',WFOutput=text_token(output('refused')))]
    w=b.build();w.update(WFWorkflowName=NAME,WFWorkflowActions=a)
    return w

if __name__=='__main__':
    path=Path(__file__).resolve().parents[1]/'shortcuts'/(NAME+'.unsigned.shortcut')
    path.write_bytes(plistlib.dumps(build(),fmt=plistlib.FMT_XML,sort_keys=False)); print(path)
