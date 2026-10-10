#!/usr/bin/env python3
"""Read-only Engine API compatibility probe; prompts for credentials; never stores them."""
import argparse, getpass, json, sys
import httpx

def main():
    p=argparse.ArgumentParser(description='Read-only oVirt Engine REST API probe')
    p.add_argument('--url',required=True,help='https://engine.example.com/ovirt-engine/api')
    p.add_argument('--ca',required=True,help='trusted Engine CA PEM file')
    p.add_argument('--username',required=True)
    a=p.parse_args()
    if not a.url.startswith('https://'):
        p.error('HTTPS is mandatory')
    password=getpass.getpass('oVirt password (not saved): ')
    results={}
    with httpx.Client(verify=a.ca,timeout=15,follow_redirects=False,auth=(a.username,password),headers={'Accept':'application/json','Version':'4'}) as client:
        for resource in ('','vms','hosts','clusters','datacenters','storagedomains','networks','events'):
            label=resource or 'root'
            try:
                r=client.get(a.url.rstrip('/')+'/'+resource,params={'max':1} if resource else None)
                results[label]={'status':r.status_code,'json':r.headers.get('content-type','').lower().startswith('application/json')}
            except httpx.HTTPError as exc:
                results[label]={'error':type(exc).__name__}
    print(json.dumps(results,indent=2))
    return 0 if all(x.get('status')==200 for x in results.values()) else 1
if __name__=='__main__':sys.exit(main())
