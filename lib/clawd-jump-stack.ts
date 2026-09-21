import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export class ClawdJumpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 버킷은 완전 비공개로 둔다. S3 정적 웹사이트 호스팅 엔드포인트는 HTTP만
    // 지원하고 버킷 공개를 요구하므로 쓰지 않는다.
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // 실습 프로젝트의 정리 편의를 위한 설정이다. 프로덕션에서는 쓰지 않는다.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // OAC는 CloudFront만 버킷을 읽을 수 있는 서명된 요청을 쓴다. 버킷을
    // 비공개로 유지하면서 HTTPS, HTTP/2, 엣지 캐싱을 얻는다. 구식 OAI보다
    // 권장되는 방식이고, 이 헬퍼가 OAC 리소스와 버킷 정책을 자동 생성한다.
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: 'Jjapgai shmup static site',
    });

    // 소스가 평범한 디렉터리 asset이므로 로컬에서 zip되며 Docker가 필요없다.
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'frontend'))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(cdk.Duration.minutes(5)),
      ],
    });

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Jjapgai shmup URL',
    });
  }
}
