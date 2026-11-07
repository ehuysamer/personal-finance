# Personal finance web (doc/requirements.md): the built site in the shared websites bucket under
# {prefix} (websites-20250103/personalfinance-dev), served by its own CloudFront distribution (origin path) on its
# own host. config.json carries the API URL and the Cognito web client, read from the API's Terraform outputs,
# so the API is deployed first.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
  backend "s3" {
    bucket         = "terraform-state-2024100601"
    key            = "infra/personalfinance/web"
    region         = "ap-southeast-2"
    encrypt        = true
    dynamodb_table = "terraform-state-lock-20241006"
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "personalfinance", environment = terraform.workspace }
  }
}

# CloudFront certificates live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = { project = "personalfinance", environment = terraform.workspace }
  }
}

variable "region" { type = string }
variable "domain_name" { type = string }
variable "websites_bucket" { type = string }
variable "prefix" { type = string }
variable "certificate_domain" {
  type    = string
  default = "*.richochet.link"
}
# The built site (scripts/deploy.sh builds dist/ first); it must not change between plan and apply.
variable "site_dir" {
  type    = string
  default = "../dist"
}

data "terraform_remote_state" "api" {
  backend   = "s3"
  workspace = terraform.workspace
  config = {
    bucket = "terraform-state-2024100601"
    key    = "infra/personalfinance/api"
    region = "ap-southeast-2"
  }
}

locals {
  name = "personalfinance-web-${terraform.workspace}"
  api  = data.terraform_remote_state.api.outputs
  host = local.api.web_host
  content_types = {
    html  = "text/html; charset=utf-8"
    css   = "text/css; charset=utf-8"
    js    = "application/javascript"
    json  = "application/json"
    svg   = "image/svg+xml"
    png   = "image/png"
    ico   = "image/x-icon"
    txt   = "text/plain; charset=utf-8"
    woff2 = "font/woff2"
  }
}

data "aws_s3_bucket" "websites" {
  bucket = var.websites_bucket
}

data "aws_route53_zone" "domain" {
  name         = var.domain_name
  private_zone = false
}

data "aws_acm_certificate" "site" {
  provider    = aws.us_east_1
  domain      = var.certificate_domain
  statuses    = ["ISSUED"]
  most_recent = true
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${local.name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  price_class         = "PriceClass_100"
  default_root_object = "index.html"
  comment             = "Personal finance web ${terraform.workspace}"
  aliases             = [local.host]

  origin {
    origin_id                = "s3-${local.name}"
    domain_name              = data.aws_s3_bucket.websites.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
    origin_path              = "/${var.prefix}"
  }

  default_cache_behavior {
    target_origin_id           = "s3-${local.name}"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  # One page (the views are in the #hash): a missing file shows it.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = data.aws_acm_certificate.site.arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }
}

resource "aws_route53_record" "ipv4" {
  zone_id = data.aws_route53_zone.domain.zone_id
  name    = local.host
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "ipv6" {
  zone_id = data.aws_route53_zone.domain.zone_id
  name    = local.host
  type    = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

# The built files (content-hashed under assets/, so cached for good; the page itself never is). The websites
# bucket's policy already lets the account's CloudFront distributions read it.
resource "aws_s3_object" "files" {
  for_each      = fileset(var.site_dir, "**")
  bucket        = data.aws_s3_bucket.websites.id
  key           = "${var.prefix}/${each.value}"
  source        = "${var.site_dir}/${each.value}"
  source_hash   = filemd5("${var.site_dir}/${each.value}")
  content_type  = lookup(local.content_types, lower(element(split(".", each.value), length(split(".", each.value)) - 1)), "application/octet-stream")
  cache_control = startswith(each.value, "assets/") ? "public, max-age=31536000, immutable" : "no-cache"
}

resource "aws_s3_object" "config" {
  bucket        = data.aws_s3_bucket.websites.id
  key           = "${var.prefix}/config.json"
  content_type  = "application/json"
  cache_control = "no-store"
  content = jsonencode({
    apiUrl        = local.api.api_url
    cognitoDomain = local.api.cognito_domain
    clientId      = local.api.web_client_id
  })
}

output "site_url" { value = "https://${local.host}" }
output "distribution_id" { value = aws_cloudfront_distribution.site.id }
