"""Validated receipt layouts; no executable HTML is accepted from the editor."""
import base64
import copy
import re
from urllib.parse import urlparse

DEFAULT_TEMPLATE = {
    'version': 1, 'paperWidth': 80, 'font': 'monospace', 'fontSize': 12, 'feed': 2,
    'blocks': [
        {'id':'store','type':'title','text':'COUNTER','align':'center','size':'large','bold':True},
        {'id':'heading','type':'text','text':None,'preset':'Sales receipt','align':'center','size':'small','bold':False},
        {'id':'meta','type':'meta','align':'center','size':'small','bold':False},
        {'id':'rule1','type':'divider','align':'center','size':'normal','bold':False},
        {'id':'items','type':'items','align':'left','size':'normal','bold':False},
        {'id':'rule2','type':'divider','align':'center','size':'normal','bold':False},
        {'id':'total','type':'total','align':'left','size':'normal','bold':True},
        {'id':'payment','type':'payment','align':'left','size':'small','bold':False},
        {'id':'rule3','type':'divider','align':'center','size':'normal','bold':False},
        {'id':'thanks','type':'text','text':None,'preset':'Thank you for shopping with us!','align':'center','size':'small','bold':False},
    ]
}
TYPES = {'title','text','meta','items','total','payment','divider','spacer','logo','barcode','qr'}
REQUIRED = {'meta','items','total'}

def default_template():
    return copy.deepcopy(DEFAULT_TEMPLATE)

def validate_template(value, barcode=False):
    if not isinstance(value, dict) or value.get('version') != 1:
        raise ValueError('Invalid receipt design.')
    width, font, size, feed = (value.get(k) for k in ('paperWidth','font','fontSize','feed'))
    if type(width) is not int or width not in (58,72,80) or font not in ('monospace','sans'):
        raise ValueError('Invalid receipt design.')
    if type(size) is not int or not 10 <= size <= 14 or type(feed) is not int or not 0 <= feed <= 4:
        raise ValueError('Invalid receipt design.')
    required = {'product_name','product_barcode','product_price'} if barcode else REQUIRED
    types = {'product_name','product_barcode','product_price','title','text','divider','spacer','logo'} if barcode else TYPES
    blocks = value.get('blocks')
    if not isinstance(blocks,list) or not 3 <= len(blocks) <= 30:
        raise ValueError('Use between 3 and 30 receipt blocks.')
    result, ids, counts = [], set(), {}
    for block in blocks:
        if not isinstance(block,dict):
            raise ValueError('Invalid receipt block.')
        kind, bid = block.get('type'), block.get('id')
        if kind not in types or not isinstance(bid,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}',bid) or bid in ids:
            raise ValueError('Invalid receipt block.')
        ids.add(bid)
        counts[kind] = counts.get(kind,0)+1
        if block.get('align') not in ('left','center','right') or block.get('size') not in ('small','normal','large') or type(block.get('bold')) is not bool:
            raise ValueError('Invalid receipt block.')
        clean = {k:block[k] for k in ('id','type','align','size','bold')}
        if kind in ('title','text'):
            text = block.get('text')
            if text is not None and (not isinstance(text,str) or len(text)>1000):
                raise ValueError('Receipt text must be 1,000 characters or fewer.')
            clean['text'] = text
            if text is None or 'preset' in block:
                preset = block.get('preset')
                if preset not in ('Sales receipt','Thank you for shopping with us!'):
                    raise ValueError('Invalid receipt block.')
                clean['preset']=preset
        if kind == 'logo':
            data = block.get('image','')
            match = re.fullmatch(r'data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)',data) if isinstance(data,str) else None
            if data and (not match or len(data)>550000):
                raise ValueError('Use a PNG, JPEG or WebP logo smaller than 400 KB.')
            if data:
                try:
                    image = base64.b64decode(match[2],validate=True)
                except ValueError:
                    raise ValueError('Invalid logo image.')
                if len(image)>400000 or not (image.startswith(b'\x89PNG\r\n\x1a\n') or image.startswith(b'\xff\xd8\xff') or (image.startswith(b'RIFF') and image[8:12]==b'WEBP')):
                    raise ValueError('Invalid logo image.')
            clean['image'] = data
        if kind == 'qr':
            url, caption = block.get('url'), block.get('caption')
            if not isinstance(url,str) or len(url)>300 or any(c.isspace() for c in url):
                raise ValueError('Enter a valid HTTP or HTTPS link for the QR code.')
            try:
                parsed = urlparse(url)
                if parsed.scheme not in ('http','https') or not parsed.hostname:
                    raise ValueError()
            except ValueError:
                raise ValueError('Enter a valid HTTP or HTTPS link for the QR code.')
            if caption is not None and (not isinstance(caption,str) or len(caption)>150):
                raise ValueError('QR caption must be 150 characters or fewer.')
            clean.update(url=url,caption=caption)
        result.append(clean)
    if any(counts.get(kind)!=1 for kind in required) or any(counts.get(kind,0)>1 for kind in ('payment','barcode','logo','qr')):
        raise ValueError('Keep one receipt number, items and total block.')
    # Keep the receipt data easy to interpret even when decorative blocks move.
    order = [block['type'] for block in result]
    if not barcode and order.index('items') > order.index('total'):
        raise ValueError('Place the total after the items.')
    return {'version':1,'paperWidth':width,'font':font,'fontSize':size,'feed':feed,'blocks':result}

DEFAULT_BARCODE_TEMPLATE = {
    'version':1,'paperWidth':80,'font':'sans','fontSize':12,'feed':0,
    'blocks':[
        {'id':'name','type':'product_name','align':'center','size':'normal','bold':True},
        {'id':'code','type':'product_barcode','align':'center','size':'normal','bold':False},
        {'id':'price','type':'product_price','align':'center','size':'normal','bold':True},
    ]
}

def default_barcode_template():
    return copy.deepcopy(DEFAULT_BARCODE_TEMPLATE)

def validate_barcode_template(value):
    try:
        return validate_template(value, barcode=True)
    except ValueError as error:
        raise ValueError(str(error).replace('receipt number, items and total','product name, barcode and price').replace('receipt','barcode'))
