{{- define "bbb-stress.name" -}}{{ .Release.Name | trunc 50 | trimSuffix "-" }}{{- end -}}
{{- define "bbb-stress.labels" -}}
app.kubernetes.io/name: bbb-stress-controller
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "bbb-stress.selector" -}}
app.kubernetes.io/name: bbb-stress-controller
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "bbb-stress.secret" -}}{{ default (include "bbb-stress.name" .) .Values.existingSecret }}{{- end -}}
