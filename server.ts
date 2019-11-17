import express, { Response } from 'express'
import http from 'http'
import { promises as fs } from 'fs'
import { google, gmail_v1 } from 'googleapis'
import readline from 'readline'
import { OAuth2Client } from 'googleapis-common'
import bodyParser from 'body-parser'
import { GaxiosResponse } from 'gaxios'
import { stdout, stderr } from 'process'
import { Console } from 'console'


const console = new Console({
  stdout, stderr,
  inspectOptions: { depth: null }
})

process.on('unhandledRejection', err => {
  console.error((err as any).stack)
  process.exit(1)
})

const app = express()
app.use(bodyParser())

app.options('/api', (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'authorization,content-type')
  res.setHeader('access-control-max-age', '86400')
  res.end()
})

// type JMAPState = number | string
type JMAPID = string
// type JMAPInvocationReq = ['Mailbox/get', { accountId: JMAPID, ids: null }, JMAPID]

type JMAPArgs = any
type JMAPInvocation = [string, JMAPArgs, JMAPID]

// type JMAPInvocationRes = ['Mailbox/get', {
//   accountId: JMAPID, list: {
//     id: JMAPID,

//   }[], notFound: any[], state: JMAPID
// }, JMAPID]

interface JMAPRequest {
  using: string[],
  methodCalls: JMAPInvocation[],
  createdIds?: JMAPID[],
}

interface Cache {
  threadCache: Map<string, gmail_v1.Schema$Thread>,
  messageCache: Map<string, gmail_v1.Schema$Message>
}

// Dodgy dodgy hax - fixme when we add authorization.
let gmail: gmail_v1.Gmail
const accountId = 'josephg@gmail.com'

function evaluatePointer(value: any, pointer: string): any {
  if (!pointer) {
    return value;
  }
  if (pointer.charAt(0) !== '/') {
    throw new Error('Invalid pointer');
  }
  let token;
  let next = pointer.indexOf('/', 1);
  if (next !== -1) {
    token = pointer.slice(1, next);
    pointer = pointer.slice(next);
  } else {
    token = pointer.slice(1);
    pointer = '';
  }
  token = token.replace(/~1/g, '/').replace(/~0/g, '~');
  if (Array.isArray(value)) {
    if (/^(?:0|[1-9][0-9]*)$/.test(token)) {
      return evaluatePointer(value[parseInt(token, 10)], pointer);
    }
    /* start: the only bit that differs from RFC6901 */
    if (token === '*') {
      /* Map values to pointer */
      value = value.map(item => evaluatePointer(item, pointer));
      /* Flatten output */
      return value.reduce((output: any, item: any[]) => {
        if (!Array.isArray(item)) {
          item = [item];
        }
        return output.concat(item);
      }, []);
    }
    /* end */
  } else if (value !== null && typeof value === 'object') {
    return evaluatePointer(value[token], pointer);
  }
  throw new Error('Evaluation failed');
}

var resolveBackRefs = function (args: JMAPArgs, responses: JMAPInvocation[]) {
  for (var property in args) {
    if (property.charAt(0) === '#') {
      const { resultOf, name, path } = args[property]
      var result = responses.find(([resName, args, tag]) => (
        name === resName && tag === resultOf
      ));
      args[property.slice(1)] = result ?
        evaluatePointer(result[1], path) :
        null; // TODO: Maybe throw?
    }
  }
  return args;
};

const parseNameAndEmail = function ( nameAndEmail: string ) {
  var name = '';
  var email = nameAndEmail;
  var match = /\b([\w.%+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,})\b/i.exec( nameAndEmail );
  if ( match ) {
      email = match[1];
      name = nameAndEmail
          .replace( email, '' )
          .replace( /['"<>\\]/g, '' )
          .trim();
  }
  return { name: name, email: email };
};

// Simple email parser, goes for good enough accuracy rather than full spec
// compliance
const parseEmails = function ( string: string | null | undefined ) {
  if (string == null) return null
  var emails = [];
  var inQuote = false;
  var start = 0;
  var end = 0;
  var length = string.length;
  var codepoint;
  while ( end < length ) {
      codepoint = string.charAt( end );
      if ( inQuote ) {
          // Skip next character if escaped
          if ( codepoint === '\\' ) {
              end += 1;
          }
          if ( codepoint === '"' ) {
              inQuote = false;
          }
      } else {
          if ( codepoint === '"' ) {
              inQuote = true;
          }
          if ( codepoint === ',' || codepoint === ';' ) {
              emails.push( parseNameAndEmail( string.slice( start, end ) ) );
              start = end + 1;
          }
      }
      end += 1;
  }
  if ( start < end ) {
      emails.push( parseNameAndEmail( string.slice( start, end ) ) );
  }
  return emails;
};

const onlyTrue = (obj: {[k: string]: boolean}) => (
  Object.fromEntries(Object.entries(obj).filter(([k,v]) => v))
)

const keywordLabels: { [id: string]: true } = {
  UNREAD: true,
  STARRED: true,
  IMPORTANT: true,
};

const resolvers: { [name: string]: (args: JMAPArgs, cache: Cache) => Promise<{ name: string, args: JMAPArgs }[]> } = {
  'Mailbox/get': async (msg) => {
    const labelsRes = await gmail.users.labels.list({
      userId: 'me',
      // fields: 'type,id,name,messagesTotal,messagesUnread,threadsTotal,threadsUnread',
    })

    const mailboxProperties: { [id: string]: any } = {
      INBOX: {
        name: 'Inbox',
        role: 'inbox',
        sortOrder: 1,
      },
      DRAFT: {
        name: 'Drafts',
        role: 'drafts',
        sortOrder: 2,
      },
      SENT: {
        name: 'Sent',
        role: 'sent',
        sortOrder: 3,
      },
      SPAM: {
        name: 'Spam',
        role: 'junk',
        sortOrder: 4,
      },
      TRASH: {
        name: 'Trash',
        role: 'trash',
        sortOrder: 5,
      },
    };


    const labels = labelsRes.data.labels!.filter(({ id }) => !keywordLabels[id!])

    const mailboxes = await Promise.all(labels!.map(async ({ id }) => {
      const info = (await gmail.users.labels.get({ userId: 'me', id: id! })).data
      // console.log('info for', id, info)
      return {
        id: info.id,
        name: info.name,
        parentId: null,
        role: null,
        sortOrder: 10,
        totalEmails: info.messagesTotal,
        unreadEmails: info.messagesUnread,
        totalThreads: info.threadsTotal,
        unreadThreads: info.threadsUnread,
        myRights: {
          mayReadItems: true,
          mayAddItems: true,
          mayRemoveItems: true,
          maySetSeen: true,
          maySetKeywords: true,
          mayCreateChild: false,
          mayRename: true,
          mayDelete: info.type !== 'system',
          maySubmit: false,
        },
        isSubscribed: true,
        ...mailboxProperties[info.id!]
      };
    }))

    // console.dir(mailboxes, {depth:null})

    return [{
      name: 'Mailbox/get',
      args: {
        accountId,
        state: 'blah',
        list: mailboxes,
        notFound: []
      }
    }]
  },


  'Email/query': async (msg, cache) => {

    if (!msg.collapseThreads) {
      throw new Error('Not implemented!');
    }

    const position = msg.position || 0
    const limit = msg.limit || 50
    let offset = 0

    let pageToken = ''
    let threadsAll = []

    while (true) {
      const q = {
        userId: 'me',
        labelIds: [] as string[],
        q: '',
        maxResults: position + limit - offset
      }

      for (const f in msg.filter) {
        const value = msg.filter[f]
        switch (f) {
          case 'inMailbox':
            q.labelIds.push(value)
            break
          default:
            console.warn('Unknown / unsupported filter type', f)
        }
        // if (f === 'inMailbox') 
      }

      const { threads, nextPageToken, resultSizeEstimate } = (await gmail.users.threads.list(q)).data;

      threadsAll.push(...threads!.map(({ id }) => id!))

      if (threadsAll.length >= position + limit || nextPageToken == null) {
        // We have enough / we've run out of input
        const threadsOut = threadsAll.slice(position, position + limit)
        // Fetch the thread objects from the ids
        const threadObjs = await Promise.all(
          threadsOut.map(async id => (
            (await gmail.users.threads.get({
              userId: 'me',
              id,
              format: 'metadata',
              metadataHeaders: ['from', 'to', 'subject']
            })).data
          ))
        )
        for (const thread of threadObjs) {
          cache.threadCache.set(thread.id!, thread)
          for (const message of thread.messages!) {
            cache.messageCache.set(message.id!, message)
          }
        }

        return [{
          name: 'Email/query',
          args: {
            accountId,
            queryState: 'asdfasdf',
            canCalculateChanges: false,
            position,
            total: resultSizeEstimate!,
            ids: threadObjs.map(t => t.messages![0].id!),
          }
        }]

        break
      } else {
        offset += threads!.length
        pageToken = nextPageToken!
      }
    }

    // return []
  },

  'Email/get': async (msg, cache) => {
    const { ids, properties }: { ids: string[], properties: string[] } = msg

    const notFound: string[] = []

    if (ids == null) return []
    // console.log('msg', msg, ids)

    properties.push('id')

    const props = ids.map(id => {
      const cacheValue = cache.messageCache.get(id)
      if (cacheValue) {
        // We've got it

        const getHeader = (msg: gmail_v1.Schema$Message, name: string) => {
          const h = msg.payload!.headers!.find(h => h.name!.toLowerCase() === name)
          return h ? h.value! : null
        }

        const getProperty: { [k: string]: (m: gmail_v1.Schema$Message) => any } = {
          id: m => m.id,
          threadId: m => m.threadId,
          mailboxIds: m => Object.fromEntries((m.labelIds as string[])
            .filter(id => !keywordLabels[id])
            .map(id => [id, true])
          ),
          keywords: m => onlyTrue({
            $seen: !m.labelIds!.includes( 'UNREAD' ),
            $flagged: m.labelIds!.includes( 'STARRED' ),
            $important: m.labelIds!.includes( 'IMPORTANT' ),
          }),
          hasAttachment: m => false,
          subject: m => getHeader(m, 'subject'),
          from: m => parseEmails(getHeader(m, 'from')),
          to: m => parseEmails(getHeader(m, 'to')),
          receivedAt: m => new Date(+m.internalDate!).toJSON(),
          size: m => m.sizeEstimate,
          preview: m => m.snippet,
        }

        return Object.fromEntries(properties.map(prop => ([prop, getProperty[prop](cacheValue)])))

        // console.log('xxxx', cacheValue, properties.map(prop => ([prop, cacheValue[prop]])))
        // return Object.fromEntries(properties.map(prop => ([prop, cacheValue[prop]])))
      } else {
        throw Error('Data not found in cache - NYI')
      }

    })


    // console.log('props', props)

    return [{
      name: 'Email/get',
      args: {
        accountId,
        state: 'asdf',
        list: props.filter(p => p !== null),
        notFound,
      }
    }]
  },

  'Thread/get': async (msg, cache) => {
    const { ids, properties } = msg as {ids: string[], properties?: string[]};

    const list = ids.map(id => {
      const thread = cache.threadCache.get(id)
      if (thread == null) throw Error('Missing thread in cache')

      return {
        id,
        emailIds: thread.messages!.map(m => m.id)
      }
    })

    return [{
      name: 'Thread/get',
      args: {
        accountId,
        state: 'asdfsfd',
        list,
        notFound: [],
      }
    }]

    // const threads = await Promise.all(ids!.map(async ({id}) => {

    //   // const info = (await gmail.users.threads.get({userId: 'me', id: id!})).data;
    //   return {
    //     id: info.id,
    //     emailIds: info.messages,
    //   };
    // }
  },
}

app.post('/api', async (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  const request = req.body as JMAPRequest
  console.log('got request', request)

  const methodResponses: JMAPInvocation[] = []

  const cache: Cache = {
    messageCache: new Map(),
    threadCache: new Map(),
  }

  for (const method of request.methodCalls) {
    const [name, args, tag] = method
    resolveBackRefs(args, methodResponses)
    if (!resolvers[name]) {
      console.error('Missing resolver for', name, args)
      continue
    }

    console.time(name)
    const responses = await resolvers[name](args, cache)
    console.timeEnd(name)
    for (const { name, args } of responses) {
      methodResponses.push([name, args, tag])
      console.log('added response', methodResponses[methodResponses.length - 1])
    }
  }

  // const methodResponses = await Promise.all(request.methodCalls.map(m => resolvers[m[0]](m))
  res.json({
    methodResponses,
    sessionState: 'todo',
  })
  res.end()
})

app.get('/event', (req, res) => {
  console.log('got /event api')
  res.end()
})

app.options('/.well-known/jmap', (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS')
  res.setHeader('access-control-allow-headers', 'authorization')
  res.setHeader('access-control-max-age', '86400')
  res.end()
})

app.get('/.well-known/jmap', (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.json({
    state: 'cyrus-0;p-3;vfs-0',
    username: 'josephg@gmail.com',
    primaryAccounts: {
      // 'urn:ietf:params:jmap:vacationresponse': 'u77a04153',
      'urn:ietf:params:jmap:submission': 'josephg@gmail.com',
      'urn:ietf:params:jmap:mail': 'josephg@gmail.com'
    },
    // downloadUrl: 'http://localhost:8000/download/{accountId}/{blobId}/{name}',
    // uploadUrl: 'http://localhost:8000/upload/{accountId}/',
    eventSourceUrl: 'http://localhost:8000/event/',
    apiUrl: 'http://localhost:8000/api/',
    accounts: {
      'josephg@gmail.com': {
        isArchiveUser: false,
        isReadOnly: false,
        name: 'me@josephg.com',
        isPersonal: true,
        accountCapabilities: {
          'urn:ietf:params:jmap:submission': { maxDelayedSend: 44236800, submissionExtensions: [] },
          'urn:ietf:params:jmap:mail': {
            maxMailboxesPerEmail: 1000,
            emailQuerySortOptions: [
              'receivedAt',
            ],
            maxMailboxDepth: null,
            mayCreateTopLevelMailbox: true,
            maxSizeMailboxName: 490,
            maxSizeAttachmentsPerEmail: 50000000
          },
          // 'urn:ietf:params:jmap:vacationresponse': {}
        }
      }
    },
    capabilities: {
      'urn:ietf:params:jmap:submission': {},
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:core': {
        maxSizeRequest: 10000000,
        maxObjectsInGet: 1000,
        maxConcurrentUpload: 10,
        maxConcurrentRequests: 10,
        maxSizeUpload: 50000000,
        maxObjectsInSet: 1000,
        collationAlgorithms: ['i;ascii-numeric', 'i;ascii-casemap', 'i;octet'],
        maxCallsInRequest: 64
      },
      // 'urn:ietf:params:jmap:vacationresponse': {}
    }
  })
})


// If modifying these scopes, delete token.json.
// To send and receive email we need this scope.
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
// const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = 'token.json';


/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
async function getNewToken(oAuth2Client: OAuth2Client): Promise<OAuth2Client> {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve, reject) => {
    rl.question('Enter the code from that page here: ', (code) => {
      rl.close();
      oAuth2Client.getToken(code, async (err, token) => {
        if (err) return reject(err);
        oAuth2Client.setCredentials(token!);
        // Store the token to disk for later program executions
        await fs.writeFile(TOKEN_PATH, JSON.stringify(token))
        console.log('Token stored to', TOKEN_PATH);
        resolve(oAuth2Client);
      });
    });
  })
}

const authorize = async (credentials: any) => {
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
    client_id, client_secret, redirect_uris[0]);

  try {
    const token = await fs.readFile(TOKEN_PATH, 'utf8')
    oAuth2Client.setCredentials(JSON.parse(token))
    return oAuth2Client
  } catch (err) {
    return await getNewToken(oAuth2Client);
  }
}

  ; (async () => {
    const credentials = JSON.parse(await fs.readFile('credentials.json', 'utf8'))

    // Authorize
    const auth = await authorize(credentials)

    const gm = google.gmail({ version: 'v1', auth })
    console.log('Validation OK!')
    gmail = gm

    // const labels = await gmail.users.labels.list({ userId: 'me' })

    // const blah = await gmail.users.messages.get({userId: 'me', id: '16e734dd08a6e39b'})
    // console.dir(blah, {depth: null})

    // const labels = await gmail.users.labels.list({userId: 'me'})
    // console.log('labels', labels.data.labels!.filter(l => l.type === 'system'))

    http.createServer(app).listen(8000)
    console.log('JMAP server listening on port 8000')
  })()




