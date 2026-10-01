// Front Door Premium + WAF: the public edge in front of the helpdesk API.
//
// VERDICT ON FRONT DOOR -> APIM, and the reason it is APIM rather than the
// portal container app directly: the gateway is where validate-jwt and the
// per-key rate limits live (infra/apim-policies/), and Front Door's origin
// private link is not available to a Consumption APIM. So the chain is
// Front Door -> APIM (public, WAF-fronted) -> portal container app. That means
// Front Door is fronting an internet-facing gateway, which is why the WAF policy
// below is not optional.
//
// THE COST POSITION, STATED PLAINLY: Premium_AzureFrontDoor is a real monthly
// charge and is NOT approved for deployment by this file. It is here so the
// template compiles and the shape is reviewable, and the deployment runbook
// treats it as a separate, cost-approved wave.
//
// Two documented constraints the runbook has to carry:
//   * The private endpoint connection Front Door creates arrives PENDING on the
//     origin and must be approved by an operator. Until it is, requests through
//     the Front Door endpoint fail. `bicep build` cannot express that.
//   * Private endpoints on Container Apps are HTTP-only, so a route to a
//     container-app origin supports Http+Https with an httpsRedirect. That is why
//     the origin below keeps both ports while the route force-redirects HTTPS and
//     the portal keeps allowInsecure: false.

targetScope = 'resourceGroup'

@description('Deployment region for the profile, endpoint and WAF policy. Front Door is regional and its region cannot be changed after creation.')
param location string

@description('Short environment name for the shared tag set.')
param environmentName string

@description('Owner contact recorded on the Front Door resources.')
param ownerContact string

@description('Name of the Front Door CDN profile. Globally unique.')
param frontDoorProfileName string

@description('Name of the Front Door endpoint. Globally unique; its hostname is the public helpdesk origin.')
param frontDoorEndpointName string

@description('Name of the origin group holding the APIM gateway origin.')
param frontDoorOriginGroupName string

@description('Name of the API Management gateway origin inside the origin group.')
param frontDoorOriginName string

@description('Name of the route mapping the endpoint to the origin group.')
param frontDoorRouteName string

@description('Name of the WAF policy.')
param frontDoorWafPolicyName string

@description('Name of the security policy that associates the WAF policy with the endpoint domain.')
param frontDoorSecurityPolicyName string

@description('Host name of the API Management gateway, used as the origin host name and origin host header.')
param apimGatewayHostName string

@description('Requests per minute per client IP the WAF rate-limit rule allows. A coarse edge guard; the per-key limits in APIM are the real quota.')
param wafRateLimitPerMinute int = 600

@description('WAF mode. "Prevention" blocks matched rules; "Detection" only logs. Start in Detection for a week against real traffic if false positives are a concern, then switch.')
param wafMode string = 'Prevention'

@description('Enable the managed bot protection rule set. Bad bots are blocked, unknown bots are logged: a helpdesk API with no bot control is a scraping target because responses are free to reuse.')
param enableBotProtection bool = true

@description('Resource id of the Log Analytics workspace receiving Front Door WAF and access logs.')
param logAnalyticsWorkspaceId string

@description('Path the origin health probe requests. /api/health is the portal liveness route (internal-portal/src/app.js:175), which loads nothing heavy.')
param healthProbePath string = '/api/health'

var tags = {
  env: environmentName
  project: 'helpdesk'
  managedBy: 'bicep'
  owner: ownerContact
}

resource frontDoorProfile 'Microsoft.Cdn/profiles@2024-09-01' = {
  name: frontDoorProfileName
  location: location
  tags: tags
  sku: {
    // Premium, not Standard. The managed WAF rule sets and bot protection are
    // Premium-only; Standard supports custom WAF rules alone, which is not
    // enough to protect an internet-facing API Management gateway.
    name: 'Premium_AzureFrontDoor'
  }
}

resource frontDoorEndpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-09-01' = {
  parent: frontDoorProfile
  name: frontDoorEndpointName
  location: location
  properties: {
    enabledState: 'Enabled'
  }
}

// Bicep ships no type definitions for AFD originGroups, origins or afdWafPolicies
// at ANY apiVersion (verified 2023-05-01 through 2026-04-01-preview), so BCP081 is
// suppressed on those three declarations rather than worked around. The property
// names below come from the documented `az afd origin-group / az afd origin /
// az afd waf-policy` parameter surface, not from guesswork.
#disable-next-line BCP081
resource frontDoorOriginGroup 'Microsoft.Cdn/profiles/afdEndpoints/originGroups@2024-09-01' = {
  parent: frontDoorEndpoint
  name: frontDoorOriginGroupName
  properties: {
    healthProbeSettings: {
      probePath: healthProbePath
      probeRequestType: 'GET'
      // HTTPS to the origin. The route force-redirects, so Front Door only ever
      // speaks TLS here.
      probeProtocol: 'Https'
      probeIntervalInSeconds: 30
    }
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
  }
}

#disable-next-line BCP081
resource frontDoorOrigin 'Microsoft.Cdn/profiles/afdEndpoints/originGroups/origins@2024-09-01' = {
  parent: frontDoorOriginGroup
  name: frontDoorOriginName
  properties: {
    hostName: apimGatewayHostName
    originHostHeader: apimGatewayHostName
    httpPort: 80
    httpsPort: 443
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    // NO sharedPrivateLinkResource here, and that is a decision not an omission:
    // a Consumption APIM cannot be reached over a private endpoint, so a
    // private-link origin would create a pending connection that can never be
    // approved. The privatise-APIM wave changes this module's comment block and
    // adds the block at that point.
  }
}

resource frontDoorRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-09-01' = {
  parent: frontDoorEndpoint
  name: frontDoorRouteName
  properties: {
    originGroup: {
      id: frontDoorOriginGroup.id
    }
    forwardingProtocol: 'MatchRequest'
    linkToDefaultDomain: 'Enabled'
    // Force HTTPS at the edge.
    httpsRedirect: 'Enabled'
    supportedProtocols: [
      'Http'
      'Https'
    ]
    patternsToMatch: [
      '/*'
    ]
  }
}

#disable-next-line BCP081
resource frontDoorWafPolicy 'Microsoft.Cdn/profiles/afdWafPolicies@2024-09-01' = {
  parent: frontDoorProfile
  name: frontDoorWafPolicyName
  properties: {
    policySettings: {
      policyType: 'WebApplicationFirewall'
      enabledState: 'Enabled'
      mode: wafMode
    }
    managedRules: {
      // concat rather than a spread: the conditional element makes the union
      // type unassignable to a fixed array, and concat produces exactly the
      // one- or two-element list the API expects.
      managedRuleSets: concat(
        [
          {
            // DRS 1.0 is the rule set validated against this origin shape. A
            // later wave should move to 2.1 as part of the Front Door rule set
            // support policy schedule, which is recorded as an open item rather
            // than silently upgraded here.
            managedRuleSetType: 'DefaultRuleSet'
            ruleSetVersion: '1.0'
          }
        ],
        // Bot protection. There is no "HighAlert" action anywhere in the AFD
        // WAF schema -- the documented action values are Allow, Block and Log --
        // so severity is expressed per bot category instead.
        enableBotProtection ? [
          {
            managedRuleSetType: 'Microsoft_BotManagerRuleSet'
            ruleSetVersion: '1.0'
            ruleGroupOverrides: [
              {
                ruleGroupName: 'BadBots'
                action: 'Block'
              }
              {
                ruleGroupName: 'UnknownBots'
                action: 'Log'
              }
            ]
          }
        ] : []
      )
    }
    customRules: [
      {
        name: 'per-client-rate-limit'
        priority: 10
        // SQLi, XSS, LFI and RCE are covered by the managed default rule set, so
        // no duplicate custom rules are added for them. The one thing the managed
        // set does not do is bound a single client, which is the abuse the
        // per-key APIM quota is meant to stop.
        ruleType: 'RateLimitRule'
        rateLimitDurationInMinutes: 1
        rateLimitThreshold: wafRateLimitPerMinute
        action: {
          actionType: 'Block'
        }
        matchConditions: [
          {
            matchVariable: 'RemoteAddr'
            operator: 'IPMatch'
            matchValue: [
              '0.0.0.0/0'
              '::/0'
            ]
            transforms: [
              'Lowercase'
            ]
          }
        ]
      }
    ]
  }
}

resource frontDoorSecurityPolicy 'Microsoft.Cdn/profiles/securityPolicies@2024-09-01' = {
  parent: frontDoorProfile
  name: frontDoorSecurityPolicyName
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: {
        id: frontDoorWafPolicy.id
      }
      associations: [
        {
          domains: [
            {
              id: frontDoorEndpoint.id
            }
          ]
          patternsToMatch: [
            '/*'
          ]
        }
      ]
    }
  }
}

// WAF decisions and access logs are the only record of what the edge blocked.
resource frontDoorDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-frontdoor'
  scope: frontDoorProfile
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'FrontDoorWebApplicationFirewallLog'
        enabled: true
      }
      {
        category: 'FrontDoorAccessLog'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

@description('Public hostname of the Front Door endpoint, e.g. "fde-helpdesk-abc123.b01.azurefd.net". This is the only helpdesk URL a browser or client should be pointed at.')
output frontDoorEndpointHostName string = frontDoorEndpoint.properties.hostName

@description('HTTPS URL of the Front Door endpoint, the canonical public helpdesk base URL.')
output frontDoorUrl string = 'https://${frontDoorEndpoint.properties.hostName}'

@description('Resource id of the Front Door profile. Scope for any future Front Door role assignment.')
output frontDoorProfileId string = frontDoorProfile.id

@description('Name of the origin group, needed by the runbook step that inspects origin health.')
output frontDoorOriginGroupNameOutput string = frontDoorOriginGroup.name