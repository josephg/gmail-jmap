# Gmail JMAP wrapper

You'll need to make a credentials.json file - https://developers.google.com/gmail/api/quickstart/nodejs then click "Enable the gmail API". Then:

```
npm install
```

Then to start the server:

```
npx ts-node server.ts
```

It gets heavily rate limited by per-user rate limits: https://developers.google.com/gmail/api/v1/reference/quota which is 250 "quota points" per second (each request uses a different number of points).