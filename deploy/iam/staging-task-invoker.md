# BIQ Staging IAM — Task Invoker Infrastructure

## Service Account

```
biq-task-invoker@spain-nextgen-staging.iam.gserviceaccount.com
```

Display name: BIQ Cloud Tasks → Run Jobs invoker (least-privilege)

## Bindings

### Cloud Run Job: club-theme-generation

```
gcloud run jobs add-iam-policy-binding club-theme-generation \
  --region europe-west1 --project spain-nextgen-staging \
  --member serviceAccount:biq-task-invoker@spain-nextgen-staging.iam.gserviceaccount.com \
  --role roles/run.jobsExecutorWithOverrides
```

### SA Token Creator (Cloud Tasks → task-invoker)

```
gcloud iam service-accounts add-iam-policy-binding \
  biq-task-invoker@spain-nextgen-staging.iam.gserviceaccount.com \
  --project spain-nextgen-staging \
  --member serviceAccount:service-859603579451@gcp-sa-cloudtasks.iam.gserviceaccount.com \
  --role roles/iam.serviceAccountTokenCreator
```

### Cloud Tasks Queue: club-theme-generation (onboard runtime enqueuer)

```
gcloud tasks queues add-iam-policy-binding club-theme-generation \
  --location europe-west1 --project spain-nextgen-staging \
  --member serviceAccount:859603579451-compute@developer.gserviceaccount.com \
  --role roles/cloudtasks.enqueuer
```

## Custom Role: biqDeployerIamReader

```
gcloud iam roles create biqDeployerIamReader \
  --project spain-nextgen-staging \
  --title "BIQ Deployer IAM Reader" \
  --description "Read-only IAM policy inspection for deploy verification" \
  --permissions iam.serviceAccounts.get,iam.serviceAccounts.getIamPolicy,run.jobs.get,run.jobs.getIamPolicy
```

### Deployer SA binding

```
gcloud projects add-iam-policy-binding spain-nextgen-staging \
  --member serviceAccount:github-actions-deployer@spain-nextgen-staging.iam.gserviceaccount.com \
  --role projects/spain-nextgen-staging/roles/biqDeployerIamReader
```
