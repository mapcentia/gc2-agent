FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Fail the build on a broken config rather than at deploy time.
RUN nginx -t
